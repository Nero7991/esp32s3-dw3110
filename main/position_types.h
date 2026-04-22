/*
 * UWB Positioning System - Shared Types
 *
 * Copyright (C) 2024
 * Licensed under GNU LGPL v3
 */

#ifndef POSITION_TYPES_H
#define POSITION_TYPES_H

#include <stdint.h>
#include <stdbool.h>

/* Device modes */
typedef enum {
    DEVICE_MODE_ANCHOR = 0,
    DEVICE_MODE_TAG = 1,
    DEVICE_MODE_TAG_PASSIVE = 2
} device_mode_t;

/* Anchor information */
typedef struct {
    uint16_t id;
    uint16_t mac;
    bool active;
} anchor_info_t;

/* Maximum number of anchors in the system */
#define MAX_ANCHORS 16

/* Ranging report structure */
typedef struct {
    uint16_t anchor_id;
    uint16_t tag_id;
    uint16_t distance_cm;
    uint32_t seq;
    int64_t timestamp_ms;
} ranging_report_t;

/* Position result (received from server) */
typedef struct {
    uint16_t tag_id;
    float x;
    float y;
    float z;
    uint16_t accuracy_cm;
} position_result_t;

/* WebSocket message types */
typedef enum {
    WS_MSG_REGISTER,
    WS_MSG_RANGING,
    WS_MSG_ANCHOR_LIST,
    WS_MSG_POSITION,
    WS_MSG_CONFIG,
    WS_MSG_HEARTBEAT
} ws_msg_type_t;

/* Connection state */
typedef enum {
    CONN_STATE_DISCONNECTED = 0,
    CONN_STATE_WIFI_CONNECTING,
    CONN_STATE_WIFI_CONNECTED,
    CONN_STATE_WS_CONNECTING,
    CONN_STATE_WS_CONNECTED,
    CONN_STATE_REGISTERED
} connection_state_t;

/* Callback types */
typedef void (*anchor_list_cb_t)(const anchor_info_t* anchors, uint8_t count);
typedef void (*position_cb_t)(const position_result_t* position);
typedef void (*connection_state_cb_t)(connection_state_t state);

#endif /* POSITION_TYPES_H */
