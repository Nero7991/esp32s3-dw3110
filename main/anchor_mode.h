/*
 * UWB Positioning System - Anchor Mode
 *
 * Anchor mode implementation for TWR responder with WebSocket reporting.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef ANCHOR_MODE_H
#define ANCHOR_MODE_H

#include <stdint.h>
#include <stdbool.h>
#include <esp_err.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize anchor mode.
 * Sets up UWB as responder and prepares for continuous RX.
 *
 * @return ESP_OK on success
 */
esp_err_t anchor_mode_init(void);

/**
 * Start anchor mode operation.
 * Begins listening for TWR poll messages and responding.
 * WebSocket must be connected before calling this.
 *
 * @return ESP_OK on success
 */
esp_err_t anchor_mode_start(void);

/**
 * Stop anchor mode operation.
 *
 * @return ESP_OK on success
 */
esp_err_t anchor_mode_stop(void);

/**
 * Check if anchor mode is running.
 *
 * @return true if active
 */
bool anchor_mode_is_running(void);

/**
 * Get number of ranging operations completed.
 *
 * @return Count of successful TWR exchanges
 */
uint32_t anchor_mode_get_ranging_count(void);

/**
 * Queue a passive tag poll request.
 * Called when server sends a poll_tag command.
 *
 * @param tag_mac UWB MAC address of the passive tag to poll
 */
void anchor_mode_poll_tag(uint16_t tag_mac);

#ifdef __cplusplus
}
#endif

#endif /* ANCHOR_MODE_H */
