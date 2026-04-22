/*
 * libdeca - UWB Library for Qorvo/Decawave DW3000
 *
 * Copyright (C) 2016 - 2024 Bruno Randolf (br@einfach.org)
 *
 * This source code is licensed under the GNU Lesser General Public License,
 * Version 3. See the file LICENSE.txt for more details.
 */

#ifndef DECA_RANGING
#define DECA_RANGING

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "dwmac.h"

/** TWR_PROCESSING_DELAY: the processing delay may need to be increased for
 * different processor and IRQ handling speeds. On ESP32-S3, the ESP-IDF SPI
 * master driver adds significant per-transaction overhead (~50-80us each),
 * and the RX-to-TX path involves ~13 SPI transactions.
 * ESP32-S3 with FreeRTOS needs ~2500us to account for interrupt latency. */
#define TWR_PROCESSING_DELAY 4000 /* us - increased to handle ESP32-S3 SPI + WiFi overhead */
#define TWR_FAILED_VALUE	 UINT16_MAX
#define TWR_OK_VALUE		 (UINT16_MAX - 1)
#define TWR_MSG_GROUP		 0x20

typedef void (*twr_cb_t)(uint64_t src, uint64_t dst, uint16_t dist,
						 uint16_t num);

/** Initialize TWR with processing delay */
void twr_init(uint32_t processing_delay_us, bool send_report);
/** Start DS-TWR (Double Sided - Two Way Ranging) bsequence to ancor */
bool twr_start(uint64_t dst);
/** Start SS-TWR (Single Sided - Two Way Ranging) sequence to ancor */
bool twr_start_ss(uint64_t dst);
bool twr_in_progress(void);
void twr_cancel(void);
void twr_set_observer(twr_cb_t cb);
uint16_t twr_get_cnum(void);
uint64_t twr_get_source_mac(void);

void twr_handle_message(const struct rxbuf* rx);
double twr_distance_calculation_dtu(uint32_t poll_rx_ts, uint32_t resp_tx_ts,
									uint32_t final_rx_ts, uint32_t Ra,
									uint32_t Da);

/*
 * Multi-anchor asymmetric DS-TWR (DW3000 User Manual §12 Appendix 1, Fig 34).
 *
 * Tag broadcasts one POLL; each anchor responds in its assigned TDMA slot;
 * tag broadcasts one FINAL carrying per-anchor RESP RX timestamps. Each
 * anchor parses the FINAL, finds its own entry, computes distance using
 * the asymmetric DS-TWR formula, and reports independently.
 *
 * This path is separate from the legacy per-pair twr_start() flow so the
 * legacy flow remains available for anchor-initiated passive-tag polls.
 */
#define TWR_MSG_POLLM 0x25
#define TWR_MSG_RESPM 0x26
#define TWR_MSG_FINAM 0x27

#define MAX_MULTI_ANCHORS 8

typedef void (*twr_multi_done_cb_t)(uint16_t cnum, uint8_t received,
									uint8_t expected);
typedef void (*twr_multi_anchor_cb_t)(uint64_t tag_mac, uint16_t my_id,
									  uint16_t dist_cm, uint16_t cnum);

/** Initialize multi-anchor TWR timing parameters. Must be called after
 * twr_init(). */
void twr_multi_init(uint32_t base_delay_us, uint32_t slot_duration_us);
/** Set this anchor's slot number. Default is device_id-1 applied by caller. */
void twr_multi_set_slot(uint8_t slot);
/** Register tag-side cycle-complete observer. */
void twr_multi_set_tag_observer(twr_multi_done_cb_t cb);
/** Register anchor-side per-distance observer. */
void twr_multi_set_anchor_observer(twr_multi_anchor_cb_t cb);
/** Start a multi-anchor cycle. anchor_count = expected number of responders. */
bool twr_start_multi(uint8_t anchor_count);

#endif
