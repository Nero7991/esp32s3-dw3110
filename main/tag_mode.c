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

/* Cycle period in ms (time between start of successive multi-anchor cycles).
 * 66 ms ≈ 15 Hz target for drone control. The inner cycle itself takes
 * ~5 ms on-air + tag processing, so this is the pacing delay. */
#define DEFAULT_CYCLE_PERIOD_MS 66

/* Multi-anchor cycle wait timeout. The libdeca path uses an internal
 * 6 ms RX window. 50 ms is safely above that under any scheduling jitter. */
#define CYCLE_TIMEOUT_MS 50

/* State */
static bool s_initialized = false;
static bool s_running = false;
static TaskHandle_t s_poll_task = NULL;
static uint32_t s_cycle_count = 0;
static uint32_t s_cycle_period_ms = DEFAULT_CYCLE_PERIOD_MS;

/* Anchor list */
static anchor_info_t s_anchors[MAX_ANCHORS];
static uint8_t s_anchor_count = 0;
static SemaphoreHandle_t s_anchor_mutex = NULL;

/* Last cycle outcome */
static SemaphoreHandle_t s_cycle_sem = NULL;
static volatile uint8_t s_last_received = 0;
static volatile uint8_t s_last_expected = 0;

/* Multi-anchor cycle-complete observer (fires from dwmac task context). */
static void tag_multi_done_cb(uint16_t cnum, uint8_t received, uint8_t expected)
{
    (void)cnum;
    s_last_received = received;
    s_last_expected = expected;
    if (s_cycle_sem) {
        xSemaphoreGive(s_cycle_sem);
    }
}

static void tag_timeout_handler(uint32_t status)
{
    /* No-op for the multi path — libdeca fires the multi observer on its
     * own RX timeout. We keep this to satisfy the dwmac_init signature and
     * for any legacy twr_start() calls (none in tag mode currently). */
    (void)status;
}

static void tag_error_handler(uint32_t status)
{
    (void)status;
}

/* One multi-anchor cycle. Returns the number of RESPs received. */
static uint8_t run_multi_cycle(uint8_t anchor_count)
{
    /* Full radio state reset + PLL re-lock before each cycle.
     *
     * Per the DW3000 User Manual §9.4 (p.240) + §10.4 (p.245): after a
     * failed delayed-TX (HPDWARN-style silent failure), the chip may have
     * fallen to IDLE_RC. dwt_setdwstate(DWT_DW_IDLE) from IDLE_RC re-runs
     * PLL calibration and waits for CPLOCK. Routing through IDLE_RC first
     * guarantees the re-cal actually fires. */
    dwt_forcetrxoff();
    dwt_setdwstate(DWT_DW_IDLE_RC);
    dwt_setdwstate(DWT_DW_IDLE);

    /* Drain any stale signal from a previous cycle. */
    xSemaphoreTake(s_cycle_sem, 0);
    s_last_received = 0;
    s_last_expected = anchor_count;

    if (!twr_start_multi(anchor_count)) {
        ESP_LOGW(TAG, "Failed to start multi cycle");
        return 0;
    }

    if (xSemaphoreTake(s_cycle_sem, pdMS_TO_TICKS(CYCLE_TIMEOUT_MS))
        != pdTRUE) {
        ESP_LOGW(TAG, "Multi cycle timed out (>%d ms)", CYCLE_TIMEOUT_MS);
        return 0;
    }

    return s_last_received;
}

/* Polling task - runs one multi-anchor cycle per period. */
static void poll_task(void* arg)
{
    (void)arg;
    ESP_LOGI(TAG, "Polling task started");

    while (s_running) {
        /* Wait for anchor list */
        if (s_anchor_count == 0) {
            ESP_LOGD(TAG, "Waiting for anchor list...");
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        xSemaphoreTake(s_anchor_mutex, portMAX_DELAY);
        uint8_t count = s_anchor_count;
        xSemaphoreGive(s_anchor_mutex);

        if (count > MAX_MULTI_ANCHORS) {
            count = MAX_MULTI_ANCHORS;
        }

        uint32_t t_start = esp_timer_get_time() / 1000;
        uint8_t received = run_multi_cycle(count);
        uint32_t elapsed = (esp_timer_get_time() / 1000) - t_start;

        s_cycle_count++;

        /* Log every 15 cycles (≈1 s at 15 Hz). */
        if (s_cycle_count % 15 == 0) {
            dwt_deviceentcnts_t counters;
            dwt_readeventcounters(&counters);
            ESP_LOGI(TAG,
                     "Cycle %" PRIu32 ": %u/%u anchors OK (%lu ms), "
                     "TXF=%u CRCG=%u",
                     s_cycle_count, received, count,
                     (unsigned long)elapsed, counters.TXF, counters.CRCG);
        }

        /* Pace to cycle period. */
        if (elapsed < s_cycle_period_ms) {
            vTaskDelay(pdMS_TO_TICKS(s_cycle_period_ms - elapsed));
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
    s_cycle_sem = xSemaphoreCreateBinary();
    s_anchor_mutex = xSemaphoreCreateMutex();
    if (!s_cycle_sem || !s_anchor_mutex) {
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

    /* Initialize TWR as initiator.
     * send_report=false: the legacy single-pair path is not used in tag mode;
     * the multi-anchor path doesn't have a REPORT phase — anchors report
     * distances to the server over WiFi. */
    ESP_LOGI(TAG, "TWR init (initiator, multi-anchor)");
    twr_init(TWR_PROCESSING_DELAY, false);
    twr_multi_init(5000 /* base delay us */, 500 /* slot duration us */);
    twr_multi_set_tag_observer(tag_multi_done_cb);

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
    /* Reinterpreted as CYCLE PERIOD (time between successive multi-anchor
     * cycles). Minimum 20 ms to avoid starving the radio and other tasks;
     * 66 ms = 15 Hz target. */
    if (interval_ms < 20) {
        interval_ms = 20;
    }
    s_cycle_period_ms = interval_ms;
    ESP_LOGI(TAG, "Cycle period set to %" PRIu32 " ms", interval_ms);
}
