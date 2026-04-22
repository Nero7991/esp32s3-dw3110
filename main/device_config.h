/*
 * UWB Positioning System - Device Configuration
 *
 * NVS-based configuration storage for device identity and settings.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef DEVICE_CONFIG_H
#define DEVICE_CONFIG_H

#include <stdint.h>
#include <stdbool.h>
#include "position_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Configuration structure stored in NVS */
typedef struct {
    device_mode_t mode;
    uint16_t device_id;
    uint16_t mac_addr;      /* UWB MAC address (16-bit) */
    char wifi_ssid[32];
    char wifi_password[64];
    char server_uri[128];
    uint16_t panid;
} device_config_t;

/**
 * Initialize device configuration subsystem.
 * Loads configuration from NVS or uses defaults from Kconfig.
 *
 * @return ESP_OK on success
 */
esp_err_t device_config_init(void);

/**
 * Get current device configuration.
 *
 * @return Pointer to configuration structure (read-only)
 */
const device_config_t* device_config_get(void);

/**
 * Save current configuration to NVS.
 *
 * @param config Configuration to save
 * @return ESP_OK on success
 */
esp_err_t device_config_save(const device_config_t* config);

/**
 * Reset configuration to defaults from Kconfig.
 *
 * @return ESP_OK on success
 */
esp_err_t device_config_reset(void);

/**
 * Generate a unique device ID based on MAC address if not set.
 *
 * @return Generated device ID
 */
uint16_t device_config_generate_id(void);

#ifdef __cplusplus
}
#endif

#endif /* DEVICE_CONFIG_H */
