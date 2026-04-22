idf_component_register(
    SRCS
        "main.c"
        "device_config.c"
        "wifi_manager.c"
        "ws_client.c"
        "anchor_mode.c"
        "tag_mode.c"
        "passive_tag_mode.c"
    INCLUDE_DIRS "."
    REQUIRES libdeca decadriver esp_wifi esp_websocket_client nvs_flash json esp_timer led_strip
    PRIV_REQUIRES driver esp_event esp_netif
)
