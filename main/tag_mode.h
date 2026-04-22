/*
 * UWB Positioning System - Tag Mode
 *
 * Tag mode implementation for TWR initiator with sequential anchor polling.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef TAG_MODE_H
#define TAG_MODE_H

#include <stdint.h>
#include <stdbool.h>
#include <esp_err.h>
#include "position_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize tag mode.
 * Sets up UWB as initiator.
 *
 * @return ESP_OK on success
 */
esp_err_t tag_mode_init(void);

/**
 * Start tag mode operation.
 * Begins polling anchors sequentially.
 * WebSocket must be connected and anchor list received before calling.
 *
 * @return ESP_OK on success
 */
esp_err_t tag_mode_start(void);

/**
 * Stop tag mode operation.
 *
 * @return ESP_OK on success
 */
esp_err_t tag_mode_stop(void);

/**
 * Check if tag mode is running.
 *
 * @return true if active
 */
bool tag_mode_is_running(void);

/**
 * Update anchor list from server.
 * Called when server sends new anchor list.
 *
 * @param anchors Array of anchor info
 * @param count Number of anchors
 */
void tag_mode_set_anchors(const anchor_info_t* anchors, uint8_t count);

/**
 * Get number of anchors configured.
 *
 * @return Number of anchors in list
 */
uint8_t tag_mode_get_anchor_count(void);

/**
 * Get number of successful ranging cycles completed.
 *
 * @return Count of complete cycles through all anchors
 */
uint32_t tag_mode_get_cycle_count(void);

/**
 * Set polling interval per anchor in milliseconds.
 *
 * @param interval_ms Time between polls to each anchor (default 50ms)
 */
void tag_mode_set_poll_interval(uint32_t interval_ms);

#ifdef __cplusplus
}
#endif

#endif /* TAG_MODE_H */
