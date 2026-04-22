/*
 * UWB Positioning System - WiFi Manager
 *
 * Handles WiFi connection with auto-reconnect capability.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include <esp_err.h>

#ifdef __cplusplus
extern "C" {
#endif

/* WiFi connection states */
typedef enum {
    WIFI_STATE_IDLE = 0,
    WIFI_STATE_CONNECTING,
    WIFI_STATE_CONNECTED,
    WIFI_STATE_DISCONNECTED,
    WIFI_STATE_FAILED
} wifi_state_t;

/* Callback for WiFi state changes */
typedef void (*wifi_state_cb_t)(wifi_state_t state);

/**
 * Initialize WiFi subsystem.
 * Must be called before any other WiFi functions.
 *
 * @return ESP_OK on success
 */
esp_err_t wifi_manager_init(void);

/**
 * Start WiFi connection using configured SSID/password.
 * Connection happens asynchronously; use callback or wifi_manager_get_state()
 * to check status.
 *
 * @return ESP_OK if connection started successfully
 */
esp_err_t wifi_manager_start(void);

/**
 * Stop WiFi and disconnect.
 *
 * @return ESP_OK on success
 */
esp_err_t wifi_manager_stop(void);

/**
 * Get current WiFi state.
 *
 * @return Current connection state
 */
wifi_state_t wifi_manager_get_state(void);

/**
 * Check if WiFi is connected.
 *
 * @return true if connected
 */
bool wifi_manager_is_connected(void);

/**
 * Wait for WiFi connection with timeout.
 *
 * @param timeout_ms Timeout in milliseconds
 * @return ESP_OK if connected, ESP_ERR_TIMEOUT if timed out
 */
esp_err_t wifi_manager_wait_connected(uint32_t timeout_ms);

/**
 * Set callback for WiFi state changes.
 *
 * @param callback Function to call on state change
 */
void wifi_manager_set_state_callback(wifi_state_cb_t callback);

/**
 * Get current IP address as string.
 *
 * @param buf Buffer to store IP address string
 * @param len Buffer length
 * @return ESP_OK on success, ESP_ERR_INVALID_STATE if not connected
 */
esp_err_t wifi_manager_get_ip_str(char* buf, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* WIFI_MANAGER_H */
