/*
 * UWB Positioning System - Passive Tag Mode
 *
 * UWB responder only. No WiFi, no WebSocket. For battery-powered tags.
 * The TWR library auto-handles incoming POLLs and sends RESPONSE/REPORT back.
 * Anchors initiate the polls and report distances to the server.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <string.h>
#include <esp_err.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "dw3000_hw.h"
#include "dwhw.h"
#include "dwmac.h"
#include "dwmac_task.h"
#include "dwphy.h"
#include "dwproto.h"
#include "ranging.h"
#include "deca_device_api.h"

#include "passive_tag_mode.h"
#include "device_config.h"

static const char* TAG = "PASSIVE_TAG";

static bool s_initialized = false;
static bool s_running = false;

static void passive_twr_done_cb(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num)
{
    ESP_LOGD(TAG, "TWR complete: src=0x%04X dist=%d cm", (uint16_t)src, dist);
}

static void passive_timeout_handler(uint32_t status)
{
    ESP_LOGD(TAG, "RX timeout: 0x%08lX", status);
}

static void passive_error_handler(uint32_t status)
{
    ESP_LOGW(TAG, "RX error: 0x%08lX", status);
}

esp_err_t passive_tag_mode_init(void)
{
    if (s_initialized) return ESP_OK;

    const device_config_t* config = device_config_get();
    ESP_LOGI(TAG, "Initializing passive tag (ID: 0x%04X, MAC: 0x%04X)",
             config->device_id, config->mac_addr);

    esp_err_t ret = dwtask_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init DW MAC task");
        return ret;
    }

    dw3000_hw_init();
    dw3000_hw_reset();
    dw3000_hw_init_interrupt();

    if (!dwhw_init()) {
        ESP_LOGE(TAG, "Failed to init libdeca");
        return ESP_FAIL;
    }

    if (!dwphy_config()) {
        ESP_LOGE(TAG, "Failed to configure dwphy");
        return ESP_FAIL;
    }
    dwphy_set_antenna_delay(DWPHY_ANTENNA_DELAY);

    if (!dwmac_init(config->panid, config->mac_addr,
                    dwprot_rx_handler, passive_timeout_handler, passive_error_handler)) {
        ESP_LOGE(TAG, "Failed to init dwmac");
        return ESP_FAIL;
    }
    dwmac_set_frame_filter();

    /* Init TWR with send_report=true so the anchor (initiator) gets the distance */
    twr_init(TWR_PROCESSING_DELAY, true);
    twr_set_observer(passive_twr_done_cb);

    s_initialized = true;
    ESP_LOGI(TAG, "Passive tag initialized");
    return ESP_OK;
}

esp_err_t passive_tag_mode_start(void)
{
    if (!s_initialized) {
        esp_err_t ret = passive_tag_mode_init();
        if (ret != ESP_OK) return ret;
    }

    if (s_running) return ESP_OK;

    ESP_LOGI(TAG, "Starting passive tag - enabling continuous RX");

    dwmac_set_rx_reenable(true);
    dwt_forcetrxoff();
    dwt_rxenable(DWT_START_RX_IMMEDIATE);

    s_running = true;
    ESP_LOGI(TAG, "Passive tag running - listening for anchor polls");
    return ESP_OK;
}

esp_err_t passive_tag_mode_stop(void)
{
    if (!s_running) return ESP_OK;

    dwt_forcetrxoff();
    dwmac_set_rx_reenable(false);
    s_running = false;
    return ESP_OK;
}

bool passive_tag_mode_is_running(void)
{
    return s_running;
}
