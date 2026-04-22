/*
 * UWB Positioning System - WebSocket Client
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <string.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_websocket_client.h>
#include <esp_event.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <cJSON.h>

#include "ws_client.h"
#include "device_config.h"

static const char* TAG = "WS_CLIENT";

/* Message queue size for offline buffering */
#define MSG_QUEUE_SIZE 32
#define MSG_MAX_LEN 256

/* Reconnect delay in ms */
#define RECONNECT_DELAY_MS 3000

/* Heartbeat interval in ms */
#define HEARTBEAT_INTERVAL_MS 2000

/* State */
static ws_state_t s_state = WS_STATE_DISCONNECTED;
static esp_websocket_client_handle_t s_client = NULL;
static QueueHandle_t s_msg_queue = NULL;
static TaskHandle_t s_sender_task = NULL;
static bool s_initialized = false;

/* Callbacks */
static ws_state_cb_t s_state_callback = NULL;
static anchor_list_cb_t s_anchor_list_callback = NULL;
static position_cb_t s_position_callback = NULL;
static config_cb_t s_config_callback = NULL;
static poll_tag_cb_t s_poll_tag_callback = NULL;
static locate_cb_t s_locate_callback = NULL;

/* Message structure for queue */
typedef struct {
    char data[MSG_MAX_LEN];
    size_t len;
} queued_msg_t;

static void set_state(ws_state_t state)
{
    if (s_state != state) {
        s_state = state;
        ESP_LOGI(TAG, "State: %d", state);
        if (s_state_callback) {
            s_state_callback(state);
        }
    }
}

static void parse_anchor_list(cJSON* anchors)
{
    if (!cJSON_IsArray(anchors) || s_anchor_list_callback == NULL) {
        return;
    }

    int count = cJSON_GetArraySize(anchors);
    if (count > MAX_ANCHORS) {
        count = MAX_ANCHORS;
    }

    anchor_info_t anchor_list[MAX_ANCHORS];
    memset(anchor_list, 0, sizeof(anchor_list));

    int i = 0;
    cJSON* anchor;
    cJSON_ArrayForEach(anchor, anchors) {
        if (i >= count) break;

        cJSON* id = cJSON_GetObjectItem(anchor, "id");
        cJSON* mac = cJSON_GetObjectItem(anchor, "mac");

        if (cJSON_IsNumber(id)) {
            anchor_list[i].id = (uint16_t)id->valueint;
        }
        if (cJSON_IsString(mac)) {
            /* Parse "0x0001" format */
            anchor_list[i].mac = (uint16_t)strtol(mac->valuestring, NULL, 0);
        } else if (cJSON_IsNumber(mac)) {
            anchor_list[i].mac = (uint16_t)mac->valueint;
        }
        anchor_list[i].active = true;
        i++;
    }

    ESP_LOGI(TAG, "Received anchor list with %d anchors", i);
    s_anchor_list_callback(anchor_list, i);
}

static void parse_position(cJSON* root)
{
    if (s_position_callback == NULL) {
        return;
    }

    position_result_t pos = {0};

    cJSON* tag_id = cJSON_GetObjectItem(root, "tag_id");
    cJSON* x = cJSON_GetObjectItem(root, "x");
    cJSON* y = cJSON_GetObjectItem(root, "y");
    cJSON* z = cJSON_GetObjectItem(root, "z");
    cJSON* accuracy = cJSON_GetObjectItem(root, "accuracy_cm");

    if (cJSON_IsNumber(tag_id)) pos.tag_id = (uint16_t)tag_id->valueint;
    if (cJSON_IsNumber(x)) pos.x = (float)x->valuedouble;
    if (cJSON_IsNumber(y)) pos.y = (float)y->valuedouble;
    if (cJSON_IsNumber(z)) pos.z = (float)z->valuedouble;
    if (cJSON_IsNumber(accuracy)) pos.accuracy_cm = (uint16_t)accuracy->valueint;

    s_position_callback(&pos);
}

static void handle_message(const char* data, size_t len)
{
    cJSON* root = cJSON_ParseWithLength(data, len);
    if (root == NULL) {
        ESP_LOGW(TAG, "Failed to parse JSON message");
        return;
    }

    cJSON* type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        cJSON_Delete(root);
        return;
    }

    const char* type_str = type->valuestring;

    if (strcmp(type_str, "anchor_list") == 0) {
        cJSON* anchors = cJSON_GetObjectItem(root, "anchors");
        parse_anchor_list(anchors);
    } else if (strcmp(type_str, "position") == 0) {
        parse_position(root);
    } else if (strcmp(type_str, "registered") == 0) {
        ESP_LOGI(TAG, "Registration confirmed");
        set_state(WS_STATE_REGISTERED);
    } else if (strcmp(type_str, "set_mode") == 0) {
        cJSON* mode = cJSON_GetObjectItem(root, "mode");
        if (cJSON_IsNumber(mode)) {
            uint8_t new_mode = (uint8_t)mode->valueint;
            ESP_LOGI(TAG, "Set mode command: %d", new_mode);

            /* Save new mode to NVS */
            device_config_t cfg = *device_config_get();
            cfg.mode = (device_mode_t)new_mode;
            device_config_save(&cfg);

            /* Clean up JSON before reboot */
            cJSON_Delete(root);

            ESP_LOGI(TAG, "Rebooting into mode %d...", new_mode);
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
            return; /* never reached */
        }
    } else if (strcmp(type_str, "locate") == 0) {
        ESP_LOGI(TAG, "Locate command received");
        if (s_locate_callback) {
            s_locate_callback();
        }
    } else if (strcmp(type_str, "poll_tag") == 0) {
        cJSON* tag_mac = cJSON_GetObjectItem(root, "tag_mac");
        if (cJSON_IsNumber(tag_mac) && s_poll_tag_callback) {
            ESP_LOGI(TAG, "Poll tag command: mac=0x%04X", (uint16_t)tag_mac->valueint);
            s_poll_tag_callback((uint16_t)tag_mac->valueint);
        }
    } else if (strcmp(type_str, "config") == 0) {
        cJSON* poll_interval = cJSON_GetObjectItem(root, "poll_interval_ms");
        if (cJSON_IsNumber(poll_interval) && s_config_callback) {
            uint32_t interval = (uint32_t)poll_interval->valueint;
            ESP_LOGI(TAG, "Config: poll_interval_ms=%lu", (unsigned long)interval);
            s_config_callback(interval);
        }
    } else if (strcmp(type_str, "error") == 0) {
        cJSON* msg = cJSON_GetObjectItem(root, "message");
        if (cJSON_IsString(msg)) {
            ESP_LOGE(TAG, "Server error: %s", msg->valuestring);
        }
    }

    cJSON_Delete(root);
}

static void websocket_event_handler(void* arg, esp_event_base_t event_base,
                                    int32_t event_id, void* event_data)
{
    esp_websocket_event_data_t* data = (esp_websocket_event_data_t*)event_data;

    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "Connected to server");
            set_state(WS_STATE_CONNECTED);
            /* Auto-register on connect */
            ws_client_send_register();
            break;

        case WEBSOCKET_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "Disconnected from server");
            set_state(WS_STATE_DISCONNECTED);
            break;

        case WEBSOCKET_EVENT_DATA:
            if (data->op_code == 0x01) {  /* Text frame */
                ESP_LOGD(TAG, "Received: %.*s", data->data_len, data->data_ptr);
                handle_message(data->data_ptr, data->data_len);
            }
            break;

        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGE(TAG, "WebSocket error");
            set_state(WS_STATE_ERROR);
            break;

        default:
            break;
    }
}

static void sender_task(void* arg)
{
    queued_msg_t msg;

    while (1) {
        /* Wait for messages in queue */
        if (xQueueReceive(s_msg_queue, &msg, pdMS_TO_TICKS(HEARTBEAT_INTERVAL_MS))) {
            /* Send queued message if connected */
            if (s_client && esp_websocket_client_is_connected(s_client)) {
                int ret = esp_websocket_client_send_text(s_client, msg.data, msg.len, portMAX_DELAY);
                if (ret < 0) {
                    ESP_LOGW(TAG, "Failed to send message, re-queuing");
                    /* Put back in queue */
                    xQueueSendToFront(s_msg_queue, &msg, 0);
                    vTaskDelay(pdMS_TO_TICKS(100));
                }
            } else {
                /* Not connected, put back in queue */
                xQueueSendToFront(s_msg_queue, &msg, 0);
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
        } else {
            /* Queue timeout - send heartbeat */
            if (s_state == WS_STATE_REGISTERED) {
                ws_client_send_heartbeat();
            }
        }
    }
}

esp_err_t ws_client_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    /* Create message queue */
    s_msg_queue = xQueueCreate(MSG_QUEUE_SIZE, sizeof(queued_msg_t));
    if (s_msg_queue == NULL) {
        ESP_LOGE(TAG, "Failed to create message queue");
        return ESP_ERR_NO_MEM;
    }

    /* Create sender task */
    BaseType_t ret = xTaskCreate(sender_task, "ws_sender", 4096, NULL, 5, &s_sender_task);
    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create sender task");
        vQueueDelete(s_msg_queue);
        s_msg_queue = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_initialized = true;
    ESP_LOGI(TAG, "Initialized");
    return ESP_OK;
}

esp_err_t ws_client_start(void)
{
    if (!s_initialized) {
        esp_err_t ret = ws_client_init();
        if (ret != ESP_OK) {
            return ret;
        }
    }

    if (s_client != NULL) {
        /* Already running */
        return ESP_OK;
    }

    const device_config_t* config = device_config_get();
    if (strlen(config->server_uri) == 0) {
        ESP_LOGE(TAG, "Server URI not configured");
        return ESP_ERR_INVALID_STATE;
    }

    esp_websocket_client_config_t ws_cfg = {
        .uri = config->server_uri,
        .reconnect_timeout_ms = RECONNECT_DELAY_MS,
        .network_timeout_ms = 10000,
        .buffer_size = 1024,
    };

    ESP_LOGI(TAG, "Connecting to: %s", config->server_uri);
    s_client = esp_websocket_client_init(&ws_cfg);
    if (s_client == NULL) {
        ESP_LOGE(TAG, "Failed to init WebSocket client");
        return ESP_FAIL;
    }

    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY,
                                  websocket_event_handler, NULL);

    set_state(WS_STATE_CONNECTING);
    esp_err_t ret = esp_websocket_client_start(s_client);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start WebSocket client");
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
        set_state(WS_STATE_ERROR);
        return ret;
    }

    return ESP_OK;
}

esp_err_t ws_client_stop(void)
{
    if (s_client != NULL) {
        esp_websocket_client_stop(s_client);
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
    }
    set_state(WS_STATE_DISCONNECTED);
    return ESP_OK;
}

ws_state_t ws_client_get_state(void)
{
    return s_state;
}

bool ws_client_is_ready(void)
{
    return s_state == WS_STATE_REGISTERED;
}

static esp_err_t queue_message(const char* json_str, size_t len)
{
    if (len >= MSG_MAX_LEN) {
        ESP_LOGW(TAG, "Message too long: %d", len);
        return ESP_ERR_INVALID_SIZE;
    }

    queued_msg_t msg;
    memcpy(msg.data, json_str, len);
    msg.data[len] = '\0';
    msg.len = len;

    if (xQueueSend(s_msg_queue, &msg, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Message queue full, dropping oldest");
        /* Remove oldest and try again */
        queued_msg_t dummy;
        xQueueReceive(s_msg_queue, &dummy, 0);
        xQueueSend(s_msg_queue, &msg, 0);
    }

    return ESP_OK;
}

esp_err_t ws_client_send_register(void)
{
    const device_config_t* config = device_config_get();

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "register");
    cJSON_AddStringToObject(root, "device_type",
                            config->mode == DEVICE_MODE_ANCHOR ? "anchor" : "tag");
    cJSON_AddNumberToObject(root, "device_id", config->device_id);

    char mac_str[8];
    snprintf(mac_str, sizeof(mac_str), "0x%04X", config->mac_addr);
    cJSON_AddStringToObject(root, "mac", mac_str);

    char* json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (json_str == NULL) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Sending registration: %s", json_str);

    esp_err_t ret = ESP_FAIL;
    if (s_client && esp_websocket_client_is_connected(s_client)) {
        int send_ret = esp_websocket_client_send_text(s_client, json_str,
                                                       strlen(json_str), portMAX_DELAY);
        ret = (send_ret >= 0) ? ESP_OK : ESP_FAIL;
    }

    free(json_str);
    return ret;
}

esp_err_t ws_client_send_ranging(const ranging_report_t* report)
{
    if (report == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "ranging");
    cJSON_AddNumberToObject(root, "anchor_id", report->anchor_id);
    cJSON_AddNumberToObject(root, "tag_id", report->tag_id);
    cJSON_AddNumberToObject(root, "distance_cm", report->distance_cm);
    cJSON_AddNumberToObject(root, "seq", report->seq);
    cJSON_AddNumberToObject(root, "ts", report->timestamp_ms);

    char* json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (json_str == NULL) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGD(TAG, "Queueing ranging: %s", json_str);
    esp_err_t ret = queue_message(json_str, strlen(json_str));
    free(json_str);

    return ret;
}

esp_err_t ws_client_send_heartbeat(void)
{
    const char* msg = "{\"type\":\"heartbeat\"}";

    if (s_client && esp_websocket_client_is_connected(s_client)) {
        int ret = esp_websocket_client_send_text(s_client, msg, strlen(msg), portMAX_DELAY);
        return (ret >= 0) ? ESP_OK : ESP_FAIL;
    }

    return ESP_ERR_INVALID_STATE;
}

void ws_client_set_state_callback(ws_state_cb_t callback)
{
    s_state_callback = callback;
}

void ws_client_set_anchor_list_callback(anchor_list_cb_t callback)
{
    s_anchor_list_callback = callback;
}

void ws_client_set_position_callback(position_cb_t callback)
{
    s_position_callback = callback;
}

void ws_client_set_config_callback(config_cb_t callback)
{
    s_config_callback = callback;
}

void ws_client_set_poll_tag_callback(poll_tag_cb_t callback)
{
    s_poll_tag_callback = callback;
}

void ws_client_set_locate_callback(locate_cb_t callback)
{
    s_locate_callback = callback;
}

uint32_t ws_client_get_queue_depth(void)
{
    if (s_msg_queue == NULL) {
        return 0;
    }
    return (uint32_t)uxQueueMessagesWaiting(s_msg_queue);
}
