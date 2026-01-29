# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ESP32-S3 with DW3110 UWB module implementation for two-way ranging (TWR). Uses Qorvo/Decawave DW3000 series chips via the libdeca library for UWB-based distance measurement.

**Supported Hardware:** DW3110 (DEVID: 0xDECA0302), DW3120 (DEVID: 0xDECA0312) on ESP32-S3

## Build Commands

```bash
# Source ESP-IDF environment first (required before any idf.py command)
. /home/orencollaco/esp/v5.3.1/esp-idf/export.sh

# Build
idf.py build

# Flash (adjust port as needed)
idf.py -p /dev/ttyS0 -b 460800 flash

# Monitor serial output
idf.py -p /dev/ttyS0 monitor

# Clean build
idf.py fullclean

# Configure (menuconfig)
idf.py menuconfig
```

## Architecture

```
Application (main/main.c)
        |
libdeca High-Level API (components/libdeca/)
  dwphy - physical layer    dwmac - MAC layer
  ranging - TWR protocol    mac802154 - frame handling
        |
Platform Layer (components/dw3000-driver/platform/esp-idf/)
  dw3000_hw - hardware init    dw3000_spi - SPI communication
        |
Qorvo Driver (components/dw3000-driver/dwt_uwb_driver/)
  deca_interface - chip abstraction
```

**Component Dependencies:**
- `main` depends on `libdeca`, `decadriver`, `driver`
- `libdeca` depends on `decadriver`
- `decadriver` depends on ESP-IDF `driver` (GPIO/SPI)

## Pin Configuration (from sdkconfig)

| Function | GPIO |
|----------|------|
| SPI MOSI | 10   |
| SPI MISO | 9    |
| SPI CLK  | 8    |
| SPI CS   | 20   |
| IRQ Reset| 5    |
| Reset    | 3    |
| Wakeup   | 4    |

## Key Configuration Options

Configuration is done via Kconfig (use `idf.py menuconfig`):

- `CONFIG_RANGING_TX` - Enable initiator mode (default) vs responder mode
- `CONFIG_DW3000_CHIP_DW3000` - Chip selection (DW3110/DW3120)
- `CONFIG_DW3000_SPI_TRACE` - SPI debug tracing
- `CONFIG_DECA_DEBUG_RX_STATUS` / `CONFIG_DECA_DEBUG_RX_DUMP` - RX debugging

Kconfig files:
- `components/dw3000-driver/platform/esp-idf/decadriver/Kconfig.projbuild` - hardware pins, chip selection
- `components/libdeca/Kconfig.projbuild` - debug and feature flags

## Key Files

- `main/main.c` - TWR demo application entry point
- `components/libdeca/ranging.c` - Two-way ranging implementation
- `components/libdeca/dwmac.c` - MAC layer with interrupt handling
- `components/dw3000-driver/platform/esp-idf/decadriver/dw3000_spi.c` - SPI communication
- `components/dw3000-driver/dwt_uwb_driver/deca_interface.c` - Chip abstraction

## Development Notes

- FreeRTOS-based with deferred interrupt processing via tasks
- libdeca licensed under GNU LGPL v3 (Bruno Randolf)
- Qorvo driver is proprietary (v08.02.02)
- Dev container available in `.devcontainer/` with ESP-IDF 5.4 pre-configured
