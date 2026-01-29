/*
 * libdeca - UWB Library for Qorvo/Decawave DW3000
 *
 * Copyright (C) 2016 - 2024 Bruno Randolf (br@einfach.org)
 *
 * This source code is licensed under the GNU Lesser General Public License,
 * Version 3. See the file LICENSE.txt for more details.
 */

#include <stdio.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_log.h>
#include <esp_err.h>

#include "dw3000_hw.h"
#include "dwhw.h"
#include "dwmac.h"
#include "dwmac_task.h"
#include "dwphy.h"
#include "dwproto.h"
#include "ranging.h"

#define PANID 0xDECA

#ifdef CONFIG_TWR_INITIATOR
#define MAC16 0x0002  // Initiator
#define TARGET_MAC 0x0001
#else
#define MAC16 0x0001  // Responder
#endif

static const char* TAG = "TWR_DEMO";

static void twr_done_cb(uint64_t src, uint64_t dst, uint16_t dist, uint16_t num) {
    ESP_LOGI(TAG, "TWR Done %04X: %d cm", (uint16_t)dst, dist);
}

static void timeout_handler(unsigned int status) {
    ESP_LOGI(TAG, "Timeout: %u", status);
}

static void error_handler(unsigned int status) {
    ESP_LOGE(TAG, "Error: %u", status);
}

static void test_twr(void) {
    esp_err_t ret;
    
    // Initialize dwmac task first
    ret = dwtask_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize DW MAC task");
        return;
    }

    // decadriver init
    ESP_LOGI(TAG, "DecaDriver init");
    dw3000_hw_init();
    dw3000_hw_reset();
    dw3000_hw_init_interrupt();
    ESP_LOGI(TAG, "DecaDriver init done");

    // libdeca init
    ESP_LOGI(TAG, "libdeca init");
    if (!dwhw_init()) {
        ESP_LOGE(TAG, "Failed to initialize libdeca");
        return;
    }
    ESP_LOGI(TAG, "libdeca init done");

    // dwphy init
    ESP_LOGI(TAG, "dwphy init");
    if (!dwphy_config()) {
        ESP_LOGE(TAG, "Failed to configure dwphy");
        return;
    }
    dwphy_set_antenna_delay(DWPHY_ANTENNA_DELAY);
    ESP_LOGI(TAG, "dwphy init done");

    // dwmac init
    ESP_LOGI(TAG, "dwmac init");
    if (!dwmac_init(PANID, MAC16, dwprot_rx_handler, timeout_handler, error_handler)) {
        ESP_LOGE(TAG, "Failed to initialize dwmac");
        return;
    }
    dwmac_set_frame_filter();
    ESP_LOGI(TAG, "dwmac init done");

    // twr init
    ESP_LOGI(TAG, "twr init");
    twr_init(TWR_PROCESSING_DELAY, true);
    twr_set_observer(twr_done_cb);

    #ifdef CONFIG_TWR_INITIATOR
        ESP_LOGI(TAG, "TWR start - initiator mode (0x%04X -> 0x%04X)", MAC16, TARGET_MAC);
        while (1) {
            twr_start(TARGET_MAC);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    #else
        ESP_LOGI(TAG, "TWR start - responder mode");
        dwmac_set_rx_reenable(true);
        dwt_forcetrxoff();
        dwt_rxenable(DWT_START_RX_IMMEDIATE);
        ESP_LOGI(TAG, "RX enabled");
    #endif
}

void app_main(void) {
    ESP_LOGI(TAG, "ESP-IDF TWR Demo Starting");
    test_twr();
}