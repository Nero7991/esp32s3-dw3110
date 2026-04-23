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

/* State */
static bool s_initialized = false;
static bool s_running = false;
static TaskHandle_t s_diag_task = NULL;

/* Anchor list (kept for compatibility with set_anchors/get_anchor_count
 * exposed in tag_mode.h, but no longer used for polling — anchors poll us). */
static anchor_info_t s_anchors[MAX_ANCHORS];
static uint8_t s_anchor_count = 0;
static SemaphoreHandle_t s_anchor_mutex = NULL;

/* Responder activity counters */
static volatile uint32_t s_responder_count = 0;
static volatile uint16_t s_last_anchor_id = 0;
static volatile uint16_t s_last_distance = 0;

/* TWR-complete observer (responder side). Fires after we send REPORT to
 * the initiating anchor. Called from the dwmac task context. */
static void tag_responder_done_cb(uint64_t src, uint64_t dst, uint16_t dist,
                                  uint16_t num)
{
    (void)dst;
    (void)num;
    s_responder_count++;
    s_last_anchor_id = (uint16_t)src;
    s_last_distance = dist;
    /* The anchor (initiator) computes the distance from its own timestamps
     * and reports it to the server via WiFi — no need for the tag to
     * report. We just keep counters for diagnostics. */
}

static void tag_timeout_handler(uint32_t status)
{
    /* In responder mode, RX timeouts are normal between anchor polls. */
    (void)status;
}

static void tag_error_handler(uint32_t status)
{
    (void)status;
}

/* SYS_STATE_LO @ 0xF0030 — byte layout (DW3000 UM §8.2.14.19):
 *   bits [7:0]    RX_STATE (sub-state within RX state machine)
 *   bits [15:8]   reserved
 *   bits [23:16]  TSE_STATE  (top-level state machine):
 *                   0x0 INIT_RC, 0x1 SLEEPING, 0x2 WAKE_UP,
 *                   0x3 IDLE_PLL, 0x4 TX_WAIT, 0x5 TX_DELAY, 0x6 TX,
 *                   0x7 RX_WAIT, 0x8 RX_DELAY, 0x9 PREAMBLE_HUNT,
 *                   0xA SFD_HUNT, 0xB RX, 0xC RX_DONE, 0xD FAIL (stuck)
 *   bits [31:24]  PMSC_STATE (power management SM)
 */
#define SYS_STATE_LO_REG_ID 0xF0030UL

static const char* tse_state_name(uint8_t v)
{
    switch (v) {
        case 0x0: return "INIT_RC";
        case 0x1: return "SLEEP";
        case 0x2: return "WAKE";
        case 0x3: return "IDLE_PLL";
        case 0x4: return "TX_WAIT";
        case 0x5: return "TX_DELAY";
        case 0x6: return "TX";
        case 0x7: return "RX_WAIT";
        case 0x8: return "RX_DELAY";
        case 0x9: return "HUNT_PRE";
        case 0xA: return "HUNT_SFD";
        case 0xB: return "RX";
        case 0xC: return "RX_DONE";
        case 0xD: return "FAIL";
        default:  return "?";
    }
}

/* Diagnostics + safety-net recovery.
 *
 * The real fix for the stall is in dwmac_irq_tx_done_cb — it now calls
 * dwt_rxenable after a fire-and-forget TX (REPORT) when rx_reenable is
 * set. Previously relied solely on the chip's DWT_RESPONSE_EXPECTED
 * auto-RX, which occasionally failed silently and left the chip in
 * IDLE_PLL.
 *
 * This task stays as a belt-and-suspenders probe: if somehow the chip
 * still ends up stalled, detect it and heal.
 */
static void diag_task(void* arg)
{
    (void)arg;
    uint32_t prev_count = 0;
    uint32_t prev_txf = 0, prev_crcg = 0;
    uint32_t consecutive_idle = 0;
    while (s_running) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        if (!s_running) break;

        dwt_deviceentcnts_t counters;
        dwt_readeventcounters(&counters);
        uint32_t cur = s_responder_count;
        uint32_t delta = cur - prev_count;
        uint32_t sys_state = dwt_read_reg(SYS_STATE_LO_REG_ID);
        uint8_t tse = (sys_state >> 16) & 0xFF;
        uint8_t pmsc = (sys_state >> 24) & 0xFF;
        uint8_t rx_sub = sys_state & 0xFF;

        ESP_LOGI(TAG,
                 "Responder: %lu polls (5s:%lu) anc=0x%04X d=%u cm | "
                 "TSE=0x%02X(%s) PMSC=0x%02X RXsub=0x%02X | "
                 "CRCG+%lu TXF+%lu PHE=%lu SFDTO=%lu PTO=%lu RTO=%lu RSL=%lu ARFE=%lu",
                 (unsigned long)cur, (unsigned long)delta,
                 s_last_anchor_id, s_last_distance,
                 tse, tse_state_name(tse), pmsc, rx_sub,
                 (unsigned long)(counters.CRCG - prev_crcg),
                 (unsigned long)(counters.TXF - prev_txf),
                 (unsigned long)counters.PHE, (unsigned long)counters.SFDTO,
                 (unsigned long)counters.PTO, (unsigned long)counters.RTO,
                 (unsigned long)counters.RSL, (unsigned long)counters.ARFE);
        prev_count = cur;
        prev_txf = counters.TXF;
        prev_crcg = counters.CRCG;

        /* If idle for two intervals (10 s), dump the stall cause then heal. */
        if (delta == 0) {
            consecutive_idle++;
            if (consecutive_idle >= 2) {
                /* Re-read state after a short delay — sometimes the first
                 * read is from a transient state. */
                vTaskDelay(pdMS_TO_TICKS(20));
                uint32_t s2 = dwt_read_reg(SYS_STATE_LO_REG_ID);
                uint8_t tse2 = (s2 >> 16) & 0xFF;
                uint8_t pmsc2 = (s2 >> 24) & 0xFF;
                ESP_LOGW(TAG,
                         "STALL ANALYSIS: stuck in TSE=0x%02X(%s) PMSC=0x%02X "
                         "(raw=0x%08lX). Kicking radio.",
                         tse2, tse_state_name(tse2), pmsc2, (unsigned long)s2);
                dwmac_set_rx_reenable(false);
                dwt_forcetrxoff();
                dwt_setdwstate(DWT_DW_IDLE_RC);
                dwt_setdwstate(DWT_DW_IDLE);
                dwmac_set_rx_reenable(true);
                dwt_rxenable(DWT_START_RX_IMMEDIATE);
                consecutive_idle = 0;
            }
        } else {
            consecutive_idle = 0;
        }
    }
    vTaskDelete(NULL);
}

esp_err_t tag_mode_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    const device_config_t* config = device_config_get();

    ESP_LOGI(TAG, "Initializing tag mode (ID: 0x%04X)", config->device_id);

    s_anchor_mutex = xSemaphoreCreateMutex();
    if (!s_anchor_mutex) {
        ESP_LOGE(TAG, "Failed to create anchor mutex");
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

    /* Initialize TWR as RESPONDER. Anchors initiate per-pair DS-TWR via
     * the server's polling-scheduler. The tag passively responds to each
     * POLL with RESP, then sends a REPORT carrying its computed distance.
     * send_report=true so the anchor (initiator) gets the distance and
     * forwards it to the server. */
    ESP_LOGI(TAG, "TWR init (responder, server-orchestrated polling)");
    twr_init(TWR_PROCESSING_DELAY, true);
    twr_set_observer(tag_responder_done_cb);

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

    ESP_LOGI(TAG, "Starting tag mode (responder)");

    s_running = true;
    s_responder_count = 0;

    /* Continuous RX so the chip auto re-arms after every received frame.
     * Anchors will send POLL frames on the server's command; libdeca's
     * twr_handle_message routes them to twr_send_response automatically. */
    dwmac_set_rx_reenable(true);
    dwt_forcetrxoff();
    dwt_rxenable(DWT_START_RX_IMMEDIATE);

    /* Diagnostic task on Core 1 (alongside UWB IRQ task) */
    BaseType_t ret = xTaskCreatePinnedToCore(diag_task, "tag_diag", 3072, NULL,
                                              5, &s_diag_task, 1);
    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create diag task");
        s_running = false;
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Tag mode started - listening for anchor polls");
    return ESP_OK;
}

esp_err_t tag_mode_stop(void)
{
    if (!s_running) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Stopping tag mode");
    s_running = false;

    vTaskDelay(pdMS_TO_TICKS(200));

    dwt_forcetrxoff();
    dwmac_set_rx_reenable(false);

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
    return s_responder_count;
}

void tag_mode_set_poll_interval(uint32_t interval_ms)
{
    /* No longer relevant in responder mode — anchors decide the rate via
     * the server's polling-scheduler. Kept as a no-op for ABI compat. */
    (void)interval_ms;
}
