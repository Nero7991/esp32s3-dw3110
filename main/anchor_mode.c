/*
 * UWB Positioning System - Anchor Mode
 *
 * Dual-role: responds to active tag TWR polls AND can initiate
 * TWR polls to passive tags on server command.
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
#include <freertos/queue.h>

#include "dw3000_hw.h"
#include "dwhw.h"
#include "dwmac.h"
#include "dwmac_task.h"
#include "dwphy.h"
#include "dwproto.h"
#include "ranging.h"
#include "deca_device_api.h"

#include "anchor_mode.h"
#include "device_config.h"
#include "ws_client.h"
#include "position_types.h"

static const char* TAG = "ANCHOR";

/* Passive tag poll queue size */
#define POLL_QUEUE_SIZE 8
#define POLL_TIMEOUT_MS 200

/* State */
static bool s_initialized = false;
static bool s_running = false;
static uint32_t s_ranging_count = 0;
static uint32_t s_seq_num = 0;
static TaskHandle_t s_diag_task = NULL;

/* Passive tag polling state */
static volatile bool s_polling_passive = false;
static SemaphoreHandle_t s_poll_sem = NULL;
static volatile uint16_t s_poll_distance = 0;
static volatile uint16_t s_poll_tag_id = 0;
static QueueHandle_t s_poll_queue = NULL;
static TaskHandle_t s_poll_task_handle = NULL;

/* Diagnostic task - logs event counters every 5 seconds */
static void diag_task(void* arg)
{
    dwt_deviceentcnts_t counters;

    while (s_running) {
        vTaskDelay(pdMS_TO_TICKS(5000));

        if (!s_running) break;

        dwt_readeventcounters(&counters);

        ESP_LOGI(TAG, "=== DW3000 Event Counters ===");
        ESP_LOGI(TAG, "CRCG (good): %u  CRCB (bad): %u  PHE: %u  RSL: %u",
                 counters.CRCG, counters.CRCB, counters.PHE, counters.RSL);
        ESP_LOGI(TAG, "ARFE (filtered): %u  SFDTO: %u  PTO: %u  RTO: %u",
                 counters.ARFE, counters.SFDTO, counters.PTO, counters.RTO);
        ESP_LOGI(TAG, "TXF (tx frames): %u  SFDD (sfd detect): %u",
                 counters.TXF, counters.SFDD);
        ESP_LOGI(TAG, "Ranging count: %" PRIu32, s_ranging_count);

        /* Re-enable RX if needed */
        if (s_running && !s_polling_passive) {
            dwt_rxenable(DWT_START_RX_IMMEDIATE);
        }
    }

    vTaskDelete(NULL);
}

/* Legacy TWR observer - retained ONLY for the passive-tag poll path, where
 * this anchor acts as the initiator. Active-tag rangings now flow through
 * the multi-anchor path and anchor_multi_result_cb below. */
static void anchor_twr_done_cb(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num)
{
    (void)dst;
    (void)num;

    if (s_polling_passive) {
        /* Result from our active poll to a passive tag */
        s_poll_distance = dist;
        s_poll_tag_id = (uint16_t)src;
        if (s_poll_sem) {
            xSemaphoreGive(s_poll_sem);
        }
        return;
    }
    /* Ignored in multi-anchor mode. */
}

/* Multi-anchor responder callback: fires once per FINAM we successfully
 * decoded, with our locally-computed distance. */
static void anchor_multi_result_cb(uint64_t tag_mac, uint16_t my_id,
                                   uint16_t dist_cm, uint16_t cnum)
{
    (void)my_id;
    (void)cnum;

    const device_config_t* config = device_config_get();

    ESP_LOGI(TAG, "TWR-M: tag=0x%04X dist=%d cm seq=%" PRIu32,
             (uint16_t)tag_mac, dist_cm, s_seq_num);

    s_ranging_count++;

    if (ws_client_is_ready()) {
        ranging_report_t report = {
            .anchor_id = config->device_id,
            .tag_id = (uint16_t)tag_mac,
            .distance_cm = dist_cm,
            .seq = s_seq_num++,
            .timestamp_ms = esp_timer_get_time() / 1000
        };
        ws_client_send_ranging(&report);
    } else {
        ESP_LOGW(TAG, "WS: Not ready (state=%d), dropping ranging report",
                 ws_client_get_state());
    }
}

static void anchor_timeout_handler(uint32_t status)
{
    if (s_polling_passive) {
        /* Timeout during passive tag poll */
        s_poll_distance = TWR_FAILED_VALUE;
        if (s_poll_sem) {
            xSemaphoreGive(s_poll_sem);
        }
        return;
    }
    ESP_LOGD(TAG, "RX timeout: 0x%08lX", status);
}

static void anchor_error_handler(uint32_t status)
{
    if (s_polling_passive) {
        s_poll_distance = TWR_FAILED_VALUE;
        if (s_poll_sem) {
            xSemaphoreGive(s_poll_sem);
        }
        return;
    }
    ESP_LOGW(TAG, "RX error: 0x%08lX", status);
}

/* Poll a passive tag - temporarily switches to initiator mode */
static bool poll_passive_tag(uint16_t tag_mac)
{
    const device_config_t* config = device_config_get();

    ESP_LOGI(TAG, "Polling passive tag 0x%04X", tag_mac);

    s_polling_passive = true;
    s_poll_distance = TWR_FAILED_VALUE;

    /* Pause continuous RX */
    dwmac_set_rx_reenable(false);
    dwt_forcetrxoff();

    /* Start TWR as initiator */
    if (!twr_start(tag_mac)) {
        ESP_LOGW(TAG, "Failed to start TWR to passive tag 0x%04X", tag_mac);
        s_polling_passive = false;
        dwmac_set_rx_reenable(true);
        dwt_rxenable(DWT_START_RX_IMMEDIATE);
        return false;
    }

    /* Wait for completion */
    bool success = false;
    if (xSemaphoreTake(s_poll_sem, pdMS_TO_TICKS(POLL_TIMEOUT_MS)) == pdTRUE) {
        if (s_poll_distance != TWR_FAILED_VALUE && s_poll_distance > 0) {
            if (ws_client_is_ready()) {
                ranging_report_t report = {
                    .anchor_id = config->device_id,
                    .tag_id = tag_mac,  /* Use the MAC we polled, not callback src */
                    .distance_cm = s_poll_distance,
                    .seq = s_seq_num++,
                    .timestamp_ms = esp_timer_get_time() / 1000
                };
                ws_client_send_ranging(&report);
            }
            ESP_LOGI(TAG, "Passive tag 0x%04X: %d cm", tag_mac, s_poll_distance);
            s_ranging_count++;
            success = true;
        }
    } else {
        ESP_LOGW(TAG, "Poll timeout for passive tag 0x%04X", tag_mac);
        twr_cancel();
    }

    /* Resume continuous RX */
    s_polling_passive = false;
    dwt_forcetrxoff();
    dwmac_set_rx_reenable(true);
    dwt_rxenable(DWT_START_RX_IMMEDIATE);

    return success;
}

/* Task that processes poll_tag commands from the server */
static void passive_poll_task(void* arg)
{
    uint16_t tag_mac;

    ESP_LOGI(TAG, "Passive poll task started");

    while (s_running) {
        if (xQueueReceive(s_poll_queue, &tag_mac, pdMS_TO_TICKS(1000))) {
            poll_passive_tag(tag_mac);
        }
    }

    ESP_LOGI(TAG, "Passive poll task stopped");
    vTaskDelete(NULL);
}

esp_err_t anchor_mode_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    const device_config_t* config = device_config_get();

    ESP_LOGI(TAG, "Initializing anchor mode (ID: 0x%04X)", config->device_id);

    /* Create passive poll semaphore and queue */
    s_poll_sem = xSemaphoreCreateBinary();
    s_poll_queue = xQueueCreate(POLL_QUEUE_SIZE, sizeof(uint16_t));
    if (!s_poll_sem || !s_poll_queue) {
        ESP_LOGE(TAG, "Failed to create poll semaphore/queue");
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
                    dwprot_rx_handler, anchor_timeout_handler, anchor_error_handler)) {
        ESP_LOGE(TAG, "Failed to initialize dwmac");
        return ESP_FAIL;
    }
    dwmac_set_frame_filter();

    /* Initialize TWR as responder.
     * Legacy (twr_start) observer is kept for the passive-tag poll path. */
    ESP_LOGI(TAG, "TWR init (responder)");
    twr_init(TWR_PROCESSING_DELAY, true);
    twr_set_observer(anchor_twr_done_cb);

    /* Multi-anchor asymmetric DS-TWR: slot = device_id - 1. Timing must
     * match what the tag configures (5000 us base, 60 us per slot). */
    uint8_t slot = (config->device_id > 0) ? (uint8_t)(config->device_id - 1) : 0;
    twr_multi_init(5000 /* base delay us */, 500 /* slot duration us */);
    twr_multi_set_slot(slot);
    twr_multi_set_anchor_observer(anchor_multi_result_cb);

    s_initialized = true;
    ESP_LOGI(TAG, "Anchor mode initialized (multi-anchor slot=%u)", slot);
    return ESP_OK;
}

esp_err_t anchor_mode_start(void)
{
    if (!s_initialized) {
        esp_err_t ret = anchor_mode_init();
        if (ret != ESP_OK) {
            return ret;
        }
    }

    if (s_running) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Starting anchor mode - enabling continuous RX");

    /* Enable continuous RX (auto re-enable after each frame) */
    dwmac_set_rx_reenable(true);

    /* Force any ongoing TX/RX off and start fresh RX */
    dwt_forcetrxoff();
    dwt_rxenable(DWT_START_RX_IMMEDIATE);

    s_running = true;
    s_ranging_count = 0;
    s_seq_num = 0;

    /* Start diagnostic task on Core 1 (same as UWB) */
    xTaskCreatePinnedToCore(diag_task, "anchor_diag", 3072, NULL, 5, &s_diag_task, 1);

    /* Start passive poll task on Core 1 */
    xTaskCreatePinnedToCore(passive_poll_task, "anchor_poll", 4096, NULL, 10, &s_poll_task_handle, 1);

    ESP_LOGI(TAG, "Anchor mode started - listening for TWR polls");
    return ESP_OK;
}

esp_err_t anchor_mode_stop(void)
{
    if (!s_running) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Stopping anchor mode");

    dwt_forcetrxoff();
    dwmac_set_rx_reenable(false);

    s_running = false;
    return ESP_OK;
}

void anchor_mode_poll_tag(uint16_t tag_mac)
{
    if (s_poll_queue && s_running) {
        xQueueSend(s_poll_queue, &tag_mac, 0);
    }
}

bool anchor_mode_is_running(void)
{
    return s_running;
}

uint32_t anchor_mode_get_ranging_count(void)
{
    return s_ranging_count;
}
