/*
 * libdeca - UWB Library for Qorvo/Decawave DW3000
 *
 * Copyright (C) 2016 - 2024 Bruno Randolf (br@einfach.org)
 *
 * This source code is licensed under the GNU Lesser General Public License,
 * Version 3. See the file LICENSE.txt for more details.
 */

#include <esp_err.h>

#include "dwmac_task.h"
#include "log.h"

static const char* LOG_TAG = "DWTASK";

/*
 * The queue and processing task are no longer needed. IRQ callbacks now call
 * dwmac_handle_*() directly from the high-priority IRQ task in dw3000_hw.c,
 * eliminating the scheduling latency that caused TWR response TX failures.
 */

int dwtask_init(void)
{
	LOG_INF("DWTASK init (direct IRQ handling)");
	return ESP_OK;
}

int dwtask_queue_event(enum dwevent_e type, const void* data)
{
	/* No longer used -- handlers are called directly from IRQ callbacks */
	(void)type;
	(void)data;
	return ESP_OK;
}
