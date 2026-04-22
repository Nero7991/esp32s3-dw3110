/*
 * UWB Positioning System - Device Configuration
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#include <string.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <nvs_flash.h>
#include <nvs.h>

#include "device_config.h"

static const char* TAG = "DEV_CFG";
static const char* NVS_NAMESPACE = "uwb_config";

/* Keys for NVS storage */
static const char* KEY_MODE = "mode";
static const char* KEY_DEVICE_ID = "device_id";
static const char* KEY_MAC_ADDR = "mac_addr";
static const char* KEY_WIFI_SSID = "wifi_ssid";
static const char* KEY_WIFI_PASS = "wifi_pass";
static const char* KEY_SERVER_URI = "server_uri";
static const char* KEY_PANID = "panid";
static const char* KEY_CONFIGURED = "configured";

/* Current configuration */
static device_config_t s_config;
static bool s_initialized = false;

/* Load defaults from Kconfig */
static void load_defaults(void)
{
    s_config.mode = CONFIG_DEVICE_MODE;
    s_config.device_id = CONFIG_DEVICE_ID;
    s_config.mac_addr = CONFIG_DEVICE_ID; /* Use device_id as MAC by default */
    strncpy(s_config.wifi_ssid, CONFIG_WIFI_SSID, sizeof(s_config.wifi_ssid) - 1);
    strncpy(s_config.wifi_password, CONFIG_WIFI_PASSWORD, sizeof(s_config.wifi_password) - 1);
    strncpy(s_config.server_uri, CONFIG_SERVER_URI, sizeof(s_config.server_uri) - 1);
    s_config.panid = CONFIG_UWB_PANID;
}

esp_err_t device_config_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    /* Initialize NVS */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition was truncated, erasing...");
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    /* Load defaults first */
    load_defaults();

    /* Try to load from NVS */
    nvs_handle_t handle;
    ret = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (ret == ESP_OK) {
        uint8_t configured = 0;
        if (nvs_get_u8(handle, KEY_CONFIGURED, &configured) == ESP_OK && configured) {
            /* Load stored configuration */
            uint8_t mode;
            if (nvs_get_u8(handle, KEY_MODE, &mode) == ESP_OK) {
                s_config.mode = (device_mode_t)mode;
            }

            nvs_get_u16(handle, KEY_DEVICE_ID, &s_config.device_id);
            nvs_get_u16(handle, KEY_MAC_ADDR, &s_config.mac_addr);
            nvs_get_u16(handle, KEY_PANID, &s_config.panid);

            size_t len = sizeof(s_config.wifi_ssid);
            nvs_get_str(handle, KEY_WIFI_SSID, s_config.wifi_ssid, &len);

            len = sizeof(s_config.wifi_password);
            nvs_get_str(handle, KEY_WIFI_PASS, s_config.wifi_password, &len);

            len = sizeof(s_config.server_uri);
            nvs_get_str(handle, KEY_SERVER_URI, s_config.server_uri, &len);

            ESP_LOGI(TAG, "Loaded configuration from NVS");
        }
        nvs_close(handle);
    } else if (ret == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "No saved configuration, using defaults");
    } else {
        ESP_LOGW(TAG, "Failed to open NVS: %s", esp_err_to_name(ret));
    }

    /* Generate device ID if not set */
    if (s_config.device_id == 0) {
        s_config.device_id = device_config_generate_id();
        s_config.mac_addr = s_config.device_id;
        ESP_LOGI(TAG, "Generated device ID: 0x%04X", s_config.device_id);
    }

    ESP_LOGI(TAG, "Config: mode=%s, id=0x%04X, mac=0x%04X, panid=0x%04X",
             s_config.mode == DEVICE_MODE_ANCHOR ? "ANCHOR" :
             s_config.mode == DEVICE_MODE_TAG ? "TAG" : "PASSIVE_TAG",
             s_config.device_id, s_config.mac_addr, s_config.panid);
    ESP_LOGI(TAG, "WiFi: %s, Server: %s", s_config.wifi_ssid, s_config.server_uri);

    s_initialized = true;
    return ESP_OK;
}

const device_config_t* device_config_get(void)
{
    if (!s_initialized) {
        device_config_init();
    }
    return &s_config;
}

esp_err_t device_config_save(const device_config_t* config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS for writing: %s", esp_err_to_name(ret));
        return ret;
    }

    /* Save all fields */
    nvs_set_u8(handle, KEY_MODE, (uint8_t)config->mode);
    nvs_set_u16(handle, KEY_DEVICE_ID, config->device_id);
    nvs_set_u16(handle, KEY_MAC_ADDR, config->mac_addr);
    nvs_set_u16(handle, KEY_PANID, config->panid);
    nvs_set_str(handle, KEY_WIFI_SSID, config->wifi_ssid);
    nvs_set_str(handle, KEY_WIFI_PASS, config->wifi_password);
    nvs_set_str(handle, KEY_SERVER_URI, config->server_uri);
    nvs_set_u8(handle, KEY_CONFIGURED, 1);

    ret = nvs_commit(handle);
    nvs_close(handle);

    if (ret == ESP_OK) {
        /* Update current config */
        memcpy(&s_config, config, sizeof(device_config_t));
        ESP_LOGI(TAG, "Configuration saved to NVS");
    } else {
        ESP_LOGE(TAG, "Failed to commit NVS: %s", esp_err_to_name(ret));
    }

    return ret;
}

esp_err_t device_config_reset(void)
{
    nvs_handle_t handle;
    esp_err_t ret = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (ret == ESP_OK) {
        nvs_erase_all(handle);
        nvs_commit(handle);
        nvs_close(handle);
    }

    load_defaults();
    ESP_LOGI(TAG, "Configuration reset to defaults");
    return ESP_OK;
}

uint16_t device_config_generate_id(void)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    /* Use last 2 bytes of WiFi MAC as device ID */
    uint16_t id = ((uint16_t)mac[4] << 8) | mac[5];

    /* Ensure non-zero and avoid reserved values */
    if (id == 0 || id == 0xFFFF) {
        id = 0x0001;
    }

    return id;
}
