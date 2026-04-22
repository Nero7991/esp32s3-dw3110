/*
 * UWB Positioning System - Main Application
 *
 * Multi-anchor positioning system using ESP32-S3 + DW3110 UWB modules.
 * Supports anchor (responder) and tag (initiator) modes with WiFi/WebSocket
 * connectivity to a central positioning server.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <stdio.h>
#include <inttypes.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_log.h>
#include <esp_err.h>
#include <driver/gpio.h>
#include <led_strip.h>

#define EXTON_GPIO 43  /* U0TXD pin - directly connected to EXTON on PCB */
#define FLOATING_GPIOS ((1ULL << 7) | (1ULL << 16) | (1ULL << 17))
#define RGB_LED_GPIO 48 /* WS2812 RGB LED */

#include "device_config.h"
#include "wifi_manager.h"
#include "ws_client.h"
#include "anchor_mode.h"
#include "tag_mode.h"
#include "passive_tag_mode.h"
#include "position_types.h"

static const char* TAG = "UWB_POS";

/* RGB LED indicator */
static led_strip_handle_t s_led_strip = NULL;

static void led_init(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = RGB_LED_GPIO,
        .max_leds = 1,
    };
    led_strip_rmt_config_t rmt_config = {
        .resolution_hz = 10 * 1000 * 1000, /* 10 MHz */
        .flags.with_dma = false,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &s_led_strip));
    led_strip_clear(s_led_strip);
}

static void led_set(uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_led_strip) return;
    led_strip_set_pixel(s_led_strip, 0, r, g, b);
    led_strip_refresh(s_led_strip);
}

/* Set LED color based on device mode -- called once at boot */
static void led_indicate_mode(void)
{
    const device_config_t* config = device_config_get();
    switch (config->mode) {
        case DEVICE_MODE_ANCHOR:      led_set(0, 0, 8);  break; /* Blue */
        case DEVICE_MODE_TAG:         led_set(0, 8, 0);  break; /* Green */
        case DEVICE_MODE_TAG_PASSIVE: led_set(8, 0, 0);  break; /* Red */
    }
}

/* Connection state */
static connection_state_t s_conn_state = CONN_STATE_DISCONNECTED;

/* Forward declarations */
static void wifi_state_callback(wifi_state_t state);
static void ws_state_callback(ws_state_t state);
static void anchor_list_callback(const anchor_info_t* anchors, uint8_t count);

static void set_conn_state(connection_state_t state)
{
    if (s_conn_state != state) {
        s_conn_state = state;
        ESP_LOGI(TAG, "Connection state: %d", state);
    }
}

static void wifi_state_callback(wifi_state_t state)
{
    switch (state) {
        case WIFI_STATE_CONNECTING:
            set_conn_state(CONN_STATE_WIFI_CONNECTING);
            break;

        case WIFI_STATE_CONNECTED:
            set_conn_state(CONN_STATE_WIFI_CONNECTED);
            /* Start WebSocket connection */
            ws_client_start();
            break;

        case WIFI_STATE_DISCONNECTED:
        case WIFI_STATE_FAILED:
            set_conn_state(CONN_STATE_DISCONNECTED);
            /* WebSocket will auto-disconnect */
            break;

        default:
            break;
    }
}

static void ws_state_callback(ws_state_t state)
{
    const device_config_t* config = device_config_get();

    switch (state) {
        case WS_STATE_CONNECTING:
            set_conn_state(CONN_STATE_WS_CONNECTING);
            break;

        case WS_STATE_CONNECTED:
            set_conn_state(CONN_STATE_WS_CONNECTED);
            break;

        case WS_STATE_REGISTERED:
            set_conn_state(CONN_STATE_REGISTERED);
            ESP_LOGI(TAG, "Registered with server - starting UWB mode");

            /* Start appropriate UWB mode */
            if (config->mode == DEVICE_MODE_ANCHOR) {
                anchor_mode_start();
            } else {
                tag_mode_start();
            }
            break;

        case WS_STATE_DISCONNECTED:
            if (wifi_manager_is_connected()) {
                set_conn_state(CONN_STATE_WIFI_CONNECTED);
            } else {
                set_conn_state(CONN_STATE_DISCONNECTED);
            }
            break;

        default:
            break;
    }
}

static void anchor_list_callback(const anchor_info_t* anchors, uint8_t count)
{
    /* Forward anchor list to tag mode */
    tag_mode_set_anchors(anchors, count);
}

static void config_callback(uint32_t poll_interval_ms)
{
    /* Forward poll interval to tag mode */
    tag_mode_set_poll_interval(poll_interval_ms);
}

static void poll_tag_callback(uint16_t tag_mac)
{
    /* Forward poll_tag command to anchor mode */
    anchor_mode_poll_tag(tag_mac);
}

/* Locate task -- blinks LED white for 10 seconds then restores mode color */
static void locate_task(void* arg)
{
    for (int i = 0; i < 20; i++) {
        led_set(40, 40, 40); /* Bright white */
        vTaskDelay(pdMS_TO_TICKS(250));
        led_set(0, 0, 0);
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    led_indicate_mode();
    vTaskDelete(NULL);
}

static void locate_callback(void)
{
    xTaskCreate(locate_task, "locate", 2048, NULL, 1, NULL);
}

static void configure_gpio(void)
{
    /* Configure GPIO43 (U0TXD) as output high for EXTON */
    gpio_config_t exton_conf = {
        .pin_bit_mask = (1ULL << EXTON_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&exton_conf);
    gpio_set_level(EXTON_GPIO, 1);
    ESP_LOGI(TAG, "EXTON (GPIO%d) set HIGH", EXTON_GPIO);

    /* Configure GPIO 7, 16, 17 as floating (high-impedance input) */
    gpio_config_t floating_conf = {
        .pin_bit_mask = FLOATING_GPIOS,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&floating_conf);
    ESP_LOGI(TAG, "GPIO 7, 16, 17 set to floating");
}

static esp_err_t initialize_subsystems(void)
{
    esp_err_t ret;
    const device_config_t* config;

    /* Initialize device configuration (NVS) */
    ret = device_config_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize device config");
        return ret;
    }

    config = device_config_get();
    ESP_LOGI(TAG, "Device: %s, ID: 0x%04X",
             config->mode == DEVICE_MODE_ANCHOR ? "ANCHOR" :
             config->mode == DEVICE_MODE_TAG ? "TAG" : "PASSIVE_TAG",
             config->device_id);

    /* Passive tag mode: UWB only, no WiFi/WebSocket */
    if (config->mode == DEVICE_MODE_TAG_PASSIVE) {
        ret = passive_tag_mode_init();
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "Failed to initialize passive tag mode");
            return ret;
        }
        passive_tag_mode_start();
        return ESP_OK;
    }

    /* Initialize WiFi manager */
    ret = wifi_manager_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize WiFi manager");
        return ret;
    }
    wifi_manager_set_state_callback(wifi_state_callback);

    /* Initialize WebSocket client */
    ret = ws_client_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize WebSocket client");
        return ret;
    }
    ws_client_set_state_callback(ws_state_callback);
    ws_client_set_anchor_list_callback(anchor_list_callback);
    ws_client_set_config_callback(config_callback);

    /* Register anchor-specific callbacks */
    if (config->mode == DEVICE_MODE_ANCHOR) {
        ws_client_set_poll_tag_callback(poll_tag_callback);
    }
    ws_client_set_locate_callback(locate_callback);

    /* Pre-initialize UWB mode (does hardware init) */
    if (config->mode == DEVICE_MODE_ANCHOR) {
        ret = anchor_mode_init();
    } else {
        ret = tag_mode_init();
    }
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize UWB mode");
        return ret;
    }

    return ESP_OK;
}

static void status_task(void* arg)
{
    const device_config_t* config = device_config_get();

    while (1) {
        /* Print status every 10 seconds */
        vTaskDelay(pdMS_TO_TICKS(10000));

        ESP_LOGI(TAG, "Status: conn=%d, wifi=%s, ws=%s",
                 s_conn_state,
                 wifi_manager_is_connected() ? "OK" : "NO",
                 ws_client_is_ready() ? "OK" : "NO");

        if (config->mode == DEVICE_MODE_ANCHOR) {
            ESP_LOGI(TAG, "Anchor ranging count: %" PRIu32,
                     anchor_mode_get_ranging_count());
        } else {
            ESP_LOGI(TAG, "Tag cycles: %" PRIu32 ", anchors: %d",
                     tag_mode_get_cycle_count(),
                     tag_mode_get_anchor_count());
        }

        ESP_LOGI(TAG, "WS queue depth: %" PRIu32, ws_client_get_queue_depth());
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "UWB Positioning System Starting");
    ESP_LOGI(TAG, "Build: %s %s", __DATE__, __TIME__);

    /* Initialize RGB LED indicator */
    led_init();

    /* Configure GPIOs */
    configure_gpio();

    /* Initialize all subsystems */
    esp_err_t ret = initialize_subsystems();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Initialization failed, halting");
        while (1) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    /* Set LED color for device mode identification */
    led_indicate_mode();

    /* Create status reporting task */
    xTaskCreate(status_task, "status", 4096, NULL, 2, NULL);

    /* Start WiFi connection */
    ESP_LOGI(TAG, "Starting WiFi connection...");
    ret = wifi_manager_start();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start WiFi");
    }

    /* Main loop - WiFi and WebSocket reconnection is handled automatically */
    ESP_LOGI(TAG, "System running");
}
