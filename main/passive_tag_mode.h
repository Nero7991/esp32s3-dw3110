/*
 * UWB Positioning System - Passive Tag Mode
 *
 * Battery-powered UWB-only tag. Responds to anchor-initiated TWR polls.
 * No WiFi or WebSocket - minimal power consumption.
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef PASSIVE_TAG_MODE_H
#define PASSIVE_TAG_MODE_H

#include <stdbool.h>
#include <esp_err.h>

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t passive_tag_mode_init(void);
esp_err_t passive_tag_mode_start(void);
esp_err_t passive_tag_mode_stop(void);
bool passive_tag_mode_is_running(void);

#ifdef __cplusplus
}
#endif

#endif /* PASSIVE_TAG_MODE_H */
