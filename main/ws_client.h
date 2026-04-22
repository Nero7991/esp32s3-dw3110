/*
 * UWB Positioning System - WebSocket Client
 *
 * Handles WebSocket connection to positioning server with message queuing.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef WS_CLIENT_H
#define WS_CLIENT_H

#include <stdint.h>
#include <stdbool.h>
#include <esp_err.h>
#include "position_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* WebSocket connection states */
typedef enum {
    WS_STATE_DISCONNECTED = 0,
    WS_STATE_CONNECTING,
    WS_STATE_CONNECTED,
    WS_STATE_REGISTERED,
    WS_STATE_ERROR
} ws_state_t;

/* Callback for WebSocket state changes */
typedef void (*ws_state_cb_t)(ws_state_t state);

/* Callback for received messages */
typedef void (*ws_message_cb_t)(const char* data, size_t len);

/**
 * Initialize WebSocket client.
 *
 * @return ESP_OK on success
 */
esp_err_t ws_client_init(void);

/**
 * Start WebSocket connection to server.
 * Requires WiFi to be connected first.
 *
 * @return ESP_OK if connection started
 */
esp_err_t ws_client_start(void);

/**
 * Stop WebSocket client and disconnect.
 *
 * @return ESP_OK on success
 */
esp_err_t ws_client_stop(void);

/**
 * Get current WebSocket state.
 *
 * @return Current connection state
 */
ws_state_t ws_client_get_state(void);

/**
 * Check if WebSocket is connected and registered.
 *
 * @return true if ready to send messages
 */
bool ws_client_is_ready(void);

/**
 * Send device registration message to server.
 *
 * @return ESP_OK if sent successfully
 */
esp_err_t ws_client_send_register(void);

/**
 * Send ranging report to server.
 *
 * @param report Ranging report data
 * @return ESP_OK if sent or queued successfully
 */
esp_err_t ws_client_send_ranging(const ranging_report_t* report);

/**
 * Send heartbeat/ping to server.
 *
 * @return ESP_OK if sent successfully
 */
esp_err_t ws_client_send_heartbeat(void);

/**
 * Set callback for WebSocket state changes.
 *
 * @param callback Function to call on state change
 */
void ws_client_set_state_callback(ws_state_cb_t callback);

/**
 * Set callback for anchor list updates (tag mode).
 *
 * @param callback Function to call when anchor list received
 */
void ws_client_set_anchor_list_callback(anchor_list_cb_t callback);

/**
 * Set callback for position updates (optional).
 *
 * @param callback Function to call when position received
 */
void ws_client_set_position_callback(position_cb_t callback);

/**
 * Callback for config updates from server (e.g. poll interval change).
 */
typedef void (*config_cb_t)(uint32_t poll_interval_ms);

/**
 * Set callback for config updates from server.
 *
 * @param callback Function to call when config received
 */
void ws_client_set_config_callback(config_cb_t callback);

/**
 * Callback for poll_tag commands from server (anchor mode).
 */
typedef void (*poll_tag_cb_t)(uint16_t tag_mac);

/**
 * Set callback for poll_tag commands from server.
 *
 * @param callback Function to call when poll_tag command received
 */
void ws_client_set_poll_tag_callback(poll_tag_cb_t callback);

/**
 * Callback for locate command from server (blink LED to identify).
 */
typedef void (*locate_cb_t)(void);

/**
 * Set callback for locate command.
 */
void ws_client_set_locate_callback(locate_cb_t callback);

/**
 * Get number of messages waiting in send queue.
 *
 * @return Queue depth
 */
uint32_t ws_client_get_queue_depth(void);

#ifdef __cplusplus
}
#endif

#endif /* WS_CLIENT_H */
