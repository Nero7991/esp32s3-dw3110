/*
 * UWB Positioning System - Tag Mode
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <string.h>
#include <inttypes.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

#include "dw3000_hw.h"
#include "dwhw.h"
#include "dwmac.h"
#include "dwmac_task.h"
#include "dwphy.h"
#include "dwproto.h"
#include "ranging.h"
#include "deca_device_api.h"

#include "tag_mode.h"
#include "device_config.h"
#include "ws_client.h"
#include "position_types.h"

static const char* TAG = "TAG";

/* Default polling interval per anchor in ms */
#define DEFAULT_POLL_INTERVAL_MS 500

/* TWR timeout in ms — covers full exchange + up to 3 libdeca retries, each
 * with a random 0–20ms backoff. 150ms is comfortable headroom. */
#define TWR_TIMEOUT_MS 150

/* State */
static bool s_initialized = false;
static bool s_running = false;
static TaskHandle_t s_poll_task = NULL;
static uint32_t s_cycle_count = 0;
static uint32_t s_seq_num = 0;
static uint32_t s_poll_interval_ms = DEFAULT_POLL_INTERVAL_MS;

/* Anchor list */
static anchor_info_t s_anchors[MAX_ANCHORS];
static uint8_t s_anchor_count = 0;
static SemaphoreHandle_t s_anchor_mutex = NULL;

/* Current TWR state */
static volatile bool s_twr_complete = false;
static volatile uint16_t s_last_distance = 0;
static volatile uint16_t s_last_anchor_id = 0;
static SemaphoreHandle_t s_twr_sem = NULL;

/* Callback when TWR completes */
static void tag_twr_done_cb(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num)
{
    s_last_distance = dist;
    s_last_anchor_id = (uint16_t)dst;
    s_twr_complete = true;

    /* Signal TWR completion */
    if (s_twr_sem) {
        xSemaphoreGive(s_twr_sem);
    }

    ESP_LOGD(TAG, "TWR done: anchor=0x%04X dist=%d cm", (uint16_t)dst, dist);
}

static void tag_timeout_handler(uint32_t status)
{
    /* Do NOT signal the semaphore here — libdeca fires this on every
     * intermediate RX timeout during its internal retry loop. Final
     * success/failure comes through tag_twr_done_cb (with dist=FAILED
     * only after all retries are exhausted). */
    ESP_LOGD(TAG, "TWR timeout: 0x%08lX", status);
}

static void tag_error_handler(uint32_t status)
{
    /* Same rationale as tag_timeout_handler: recoverable via libdeca retries. */
    ESP_LOGD(TAG, "TWR error: 0x%08lX", status);
}

/* Poll a single anchor and report result */
static bool poll_anchor(uint16_t anchor_mac)
{
    const device_config_t* config = device_config_get();

    s_twr_complete = false;
    s_last_distance = TWR_FAILED_VALUE;

    ESP_LOGI(TAG, "Polling anchor 0x%04X...", anchor_mac);

    /* Full radio state reset + PLL re-lock before each poll.
     *
     * Per the DW3000 User Manual §9.4 (p.240) + §10.4 (p.245): after a
     * failed delayed-TX (HPDWARN-style silent failure), the chip may have
     * fallen to IDLE_RC. dwt_setdwstate(DWT_DW_IDLE) from IDLE_RC re-runs
     * PLL calibration and waits for CPLOCK. We explicitly route through
     * IDLE_RC first so the re-cal actually fires. */
    dwt_forcetrxoff();
    dwt_setdwstate(DWT_DW_IDLE_RC);
    dwt_setdwstate(DWT_DW_IDLE);

    /* Start DS-TWR to anchor */
    if (!twr_start(anchor_mac)) {
        ESP_LOGW(TAG, "Failed to start TWR to 0x%04X", anchor_mac);
        return false;
    }

    ESP_LOGD(TAG, "TWR started, waiting for response...");

    /* Wait for TWR completion with timeout */
    if (xSemaphoreTake(s_twr_sem, pdMS_TO_TICKS(TWR_TIMEOUT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "TWR timeout waiting for 0x%04X", anchor_mac);
        twr_cancel();
        return false;
    }

    /* Check result */
    if (s_last_distance == TWR_FAILED_VALUE) {
        ESP_LOGD(TAG, "TWR failed to 0x%04X", anchor_mac);
        return false;
    }

    /* Send ranging report via WebSocket */
    if (ws_client_is_ready()) {
        ranging_report_t report = {
            .anchor_id = anchor_mac,
            .tag_id = config->device_id,
            .distance_cm = s_last_distance,
            .seq = s_seq_num++,
            .timestamp_ms = esp_timer_get_time() / 1000
        };
        ws_client_send_ranging(&report);
    }

    ESP_LOGI(TAG, "Anchor 0x%04X: %d cm", anchor_mac, s_last_distance);
    return true;
}

/* Polling task - cycles through all anchors */
static void poll_task(void* arg)
{
    ESP_LOGI(TAG, "Polling task started");

    while (s_running) {
        /* Wait for anchor list */
        if (s_anchor_count == 0) {
            ESP_LOGD(TAG, "Waiting for anchor list...");
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        /* Poll each anchor */
        xSemaphoreTake(s_anchor_mutex, portMAX_DELAY);
        uint8_t count = s_anchor_count;
        anchor_info_t anchors[MAX_ANCHORS];
        memcpy(anchors, s_anchors, sizeof(anchor_info_t) * count);
        xSemaphoreGive(s_anchor_mutex);

        uint8_t success_count = 0;
        for (uint8_t i = 0; i < count && s_running; i++) {
            if (anchors[i].active) {
                if (poll_anchor(anchors[i].mac)) {
                    success_count++;
                }
                vTaskDelay(pdMS_TO_TICKS(s_poll_interval_ms));
            }
        }

        s_cycle_count++;

        /* Log every 10 cycles */
        if (s_cycle_count % 10 == 0) {
            dwt_deviceentcnts_t counters;
            dwt_readeventcounters(&counters);
            ESP_LOGI(TAG, "Cycle %" PRIu32 ": %d/%d anchors OK, TXF=%u CRCG=%u",
                     s_cycle_count, success_count, count,
                     counters.TXF, counters.CRCG);
        }
    }

    ESP_LOGI(TAG, "Polling task stopped");
    vTaskDelete(NULL);
}

esp_err_t tag_mode_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    const device_config_t* config = device_config_get();

    ESP_LOGI(TAG, "Initializing tag mode (ID: 0x%04X)", config->device_id);

    /* Create semaphores */
    s_twr_sem = xSemaphoreCreateBinary();
    s_anchor_mutex = xSemaphoreCreateMutex();
    if (!s_twr_sem || !s_anchor_mutex) {
        ESP_LOGE(TAG, "Failed to create semaphores");
        return ESP_ERR_NO_MEM;
    }

    /* Initialize dwmac task */
    esp_err_t ret = dwtask_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize DW MAC task");
        return ret;
    }

    /* Initialize decadriver */
    ESP_LOGI(TAG, "DecaDriver init");
    dw3000_hw_init();
    dw3000_hw_reset();
    dw3000_hw_init_interrupt();

    /* Initialize libdeca */
    ESP_LOGI(TAG, "libdeca init");
    if (!dwhw_init()) {
        ESP_LOGE(TAG, "Failed to initialize libdeca");
        return ESP_FAIL;
    }

    /* Configure dwphy */
    ESP_LOGI(TAG, "dwphy config");
    if (!dwphy_config()) {
        ESP_LOGE(TAG, "Failed to configure dwphy");
        return ESP_FAIL;
    }
    dwphy_set_antenna_delay(DWPHY_ANTENNA_DELAY);

    /* Initialize dwmac */
    ESP_LOGI(TAG, "dwmac init");
    if (!dwmac_init(config->panid, config->mac_addr,
                    dwprot_rx_handler, tag_timeout_handler, tag_error_handler)) {
        ESP_LOGE(TAG, "Failed to initialize dwmac");
        return ESP_FAIL;
    }
    dwmac_set_frame_filter();

    /* Initialize TWR as initiator */
    ESP_LOGI(TAG, "TWR init (initiator)");
    twr_init(TWR_PROCESSING_DELAY, true);
    twr_set_observer(tag_twr_done_cb);

    s_initialized = true;
    ESP_LOGI(TAG, "Tag mode initialized");
    return ESP_OK;
}

esp_err_t tag_mode_start(void)
{
    if (!s_initialized) {
        esp_err_t ret = tag_mode_init();
        if (ret != ESP_OK) {
            return ret;
        }
    }

    if (s_running) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Starting tag mode");

    s_running = true;
    s_cycle_count = 0;
    s_seq_num = 0;

    /* Create polling task on Core 1 (same as UWB IRQ) to avoid WiFi interference */
    BaseType_t ret = xTaskCreatePinnedToCore(poll_task, "tag_poll", 4096, NULL, 10, &s_poll_task, 1);
    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create polling task");
        s_running = false;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Tag mode started");
    return ESP_OK;
}

esp_err_t tag_mode_stop(void)
{
    if (!s_running) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Stopping tag mode");
    s_running = false;

    /* Wait for task to finish */
    vTaskDelay(pdMS_TO_TICKS(200));

    twr_cancel();
    dwt_forcetrxoff();

    return ESP_OK;
}

bool tag_mode_is_running(void)
{
    return s_running;
}

void tag_mode_set_anchors(const anchor_info_t* anchors, uint8_t count)
{
    if (anchors == NULL || count == 0) {
        return;
    }

    if (count > MAX_ANCHORS) {
        count = MAX_ANCHORS;
    }

    xSemaphoreTake(s_anchor_mutex, portMAX_DELAY);
    memcpy(s_anchors, anchors, sizeof(anchor_info_t) * count);
    s_anchor_count = count;
    xSemaphoreGive(s_anchor_mutex);

    ESP_LOGI(TAG, "Anchor list updated: %d anchors", count);
    for (int i = 0; i < count; i++) {
        ESP_LOGI(TAG, "  Anchor %d: id=%d mac=0x%04X",
                 i, anchors[i].id, anchors[i].mac);
    }
}

uint8_t tag_mode_get_anchor_count(void)
{
    return s_anchor_count;
}

uint32_t tag_mode_get_cycle_count(void)
{
    return s_cycle_count;
}

void tag_mode_set_poll_interval(uint32_t interval_ms)
{
    /* Minimum 5ms to avoid starving the radio and other tasks */
    if (interval_ms < 5) {
        interval_ms = 5;
    }
    s_poll_interval_ms = interval_ms;
    ESP_LOGI(TAG, "Poll interval set to %" PRIu32 " ms", interval_ms);
}
