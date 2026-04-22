/*
 * UWB Positioning System - WiFi Manager
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <string.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_netif.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/event_groups.h>

#include "wifi_manager.h"
#include "device_config.h"

static const char* TAG = "WIFI_MGR";

/* Event group bits */
#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1

/* Maximum connection retry attempts before giving up temporarily */
#define MAX_RETRY_COUNT 5

/* Retry delay in ms */
#define RETRY_DELAY_MS 5000

/* State */
static wifi_state_t s_state = WIFI_STATE_IDLE;
static EventGroupHandle_t s_wifi_event_group = NULL;
static esp_netif_t* s_sta_netif = NULL;
static wifi_state_cb_t s_state_callback = NULL;
static int s_retry_count = 0;
static bool s_initialized = false;
static esp_ip4_addr_t s_ip_addr;

static void set_state(wifi_state_t state)
{
    if (s_state != state) {
        s_state = state;
        ESP_LOGI(TAG, "State: %d", state);
        if (s_state_callback) {
            s_state_callback(state);
        }
    }
}

static void wifi_event_handler(void* arg, esp_event_base_t event_base,
                               int32_t event_id, void* event_data)
{
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "STA started, connecting...");
                set_state(WIFI_STATE_CONNECTING);
                esp_wifi_connect();
                break;

            case WIFI_EVENT_STA_DISCONNECTED: {
                wifi_event_sta_disconnected_t* event =
                    (wifi_event_sta_disconnected_t*)event_data;
                ESP_LOGW(TAG, "Disconnected, reason: %d", event->reason);
                set_state(WIFI_STATE_DISCONNECTED);

                if (s_retry_count < MAX_RETRY_COUNT) {
                    s_retry_count++;
                    ESP_LOGI(TAG, "Retry %d/%d in %d ms",
                             s_retry_count, MAX_RETRY_COUNT, RETRY_DELAY_MS);
                    vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
                    set_state(WIFI_STATE_CONNECTING);
                    esp_wifi_connect();
                } else {
                    ESP_LOGE(TAG, "Max retries reached, connection failed");
                    set_state(WIFI_STATE_FAILED);
                    xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
                    /* Reset retry count for future reconnection attempts */
                    s_retry_count = 0;
                }
                break;
            }

            case WIFI_EVENT_STA_CONNECTED:
                ESP_LOGI(TAG, "Connected to AP");
                s_retry_count = 0;
                break;

            default:
                break;
        }
    } else if (event_base == IP_EVENT) {
        switch (event_id) {
            case IP_EVENT_STA_GOT_IP: {
                ip_event_got_ip_t* event = (ip_event_got_ip_t*)event_data;
                s_ip_addr = event->ip_info.ip;
                ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
                set_state(WIFI_STATE_CONNECTED);
                xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
                break;
            }

            case IP_EVENT_STA_LOST_IP:
                ESP_LOGW(TAG, "Lost IP address");
                memset(&s_ip_addr, 0, sizeof(s_ip_addr));
                break;

            default:
                break;
        }
    }
}

esp_err_t wifi_manager_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    /* Create event group */
    s_wifi_event_group = xEventGroupCreate();
    if (s_wifi_event_group == NULL) {
        ESP_LOGE(TAG, "Failed to create event group");
        return ESP_ERR_NO_MEM;
    }

    /* Initialize TCP/IP stack */
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    /* Create default WiFi station */
    s_sta_netif = esp_netif_create_default_wifi_sta();
    if (s_sta_netif == NULL) {
        ESP_LOGE(TAG, "Failed to create netif");
        return ESP_FAIL;
    }

    /* Initialize WiFi with default config */
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    /* Register event handlers */
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));

    s_initialized = true;
    ESP_LOGI(TAG, "Initialized");
    return ESP_OK;
}

esp_err_t wifi_manager_start(void)
{
    if (!s_initialized) {
        esp_err_t ret = wifi_manager_init();
        if (ret != ESP_OK) {
            return ret;
        }
    }

    const device_config_t* config = device_config_get();
    if (strlen(config->wifi_ssid) == 0) {
        ESP_LOGE(TAG, "WiFi SSID not configured");
        return ESP_ERR_INVALID_STATE;
    }

    /* Configure WiFi */
    wifi_config_t wifi_config = {
        .sta = {
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
            .sae_pwe_h2e = WPA3_SAE_PWE_BOTH,
        },
    };
    strncpy((char*)wifi_config.sta.ssid, config->wifi_ssid,
            sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char*)wifi_config.sta.password, config->wifi_password,
            sizeof(wifi_config.sta.password) - 1);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));

    /* Clear event bits */
    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);
    s_retry_count = 0;

    ESP_LOGI(TAG, "Starting WiFi, connecting to: %s", config->wifi_ssid);
    ESP_ERROR_CHECK(esp_wifi_start());

    return ESP_OK;
}

esp_err_t wifi_manager_stop(void)
{
    if (!s_initialized) {
        return ESP_OK;
    }

    esp_wifi_disconnect();
    esp_wifi_stop();
    set_state(WIFI_STATE_IDLE);

    return ESP_OK;
}

wifi_state_t wifi_manager_get_state(void)
{
    return s_state;
}

bool wifi_manager_is_connected(void)
{
    return s_state == WIFI_STATE_CONNECTED;
}

esp_err_t wifi_manager_wait_connected(uint32_t timeout_ms)
{
    if (!s_initialized || s_wifi_event_group == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE,  /* Don't clear bits on exit */
        pdFALSE,  /* Wait for any bit */
        pdMS_TO_TICKS(timeout_ms)
    );

    if (bits & WIFI_CONNECTED_BIT) {
        return ESP_OK;
    } else if (bits & WIFI_FAIL_BIT) {
        return ESP_FAIL;
    } else {
        return ESP_ERR_TIMEOUT;
    }
}

void wifi_manager_set_state_callback(wifi_state_cb_t callback)
{
    s_state_callback = callback;
}

esp_err_t wifi_manager_get_ip_str(char* buf, size_t len)
{
    if (buf == NULL || len < 16) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_state != WIFI_STATE_CONNECTED) {
        return ESP_ERR_INVALID_STATE;
    }

    snprintf(buf, len, IPSTR, IP2STR(&s_ip_addr));
    return ESP_OK;
}
