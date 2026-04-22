# FIXES.md

Hardware and firmware issues found during development, with fixes for future board revisions.

## HW-001: DW3110 PLL Instability During Initiator TX-RX Cycling

**Status:** Confirmed, needs hardware fix in next revision
**Severity:** High -- causes >90% ranging failure rate when polling 3+ anchors
**Affected:** Tag (initiator) boards only. Anchors (responder) are unaffected.

### Symptoms

- `Clock PLL Losing Lock` on every TWR poll attempt (3.3 PLL losses per poll)
- `SPI CRC error` coinciding with each PLL loss event
- PLL loss occurs 10-30ms after each poll starts (during TX-RX transition)
- 0% success rate when polling 3 anchors sequentially
- Single-anchor polling works (lower duty cycle allows PLL recovery between polls)

### Evidence

**Tag (initiator) -- 15 second sample:**
```
Polls attempted: 7
Successes: 0
PLL lock losses: 23
SPI CRC errors: 22
PLL loss per poll: 3.3
```

**Anchors (responder) -- same 15 second window:**
```
Anchor 1: PLL losses=0, SPI CRC errors=0, TXF=132
Anchor 2: PLL losses=0, SPI CRC errors=0, TXF=1495
Anchor 3: PLL losses=0, SPI CRC errors=0, TXF=71
```

Anchors transmit (TX RESPONSE/REPORT frames) without any PLL issues. The difference is the TX-RX switching pattern:

- **Anchor (works):** Idle RX -> receives POLL -> TX RESPONSE -> back to idle RX. Infrequent TX with stable RX periods between.
- **Tag (fails):** TX POLL -> switch to RX -> preamble timeout (PLL loss) -> immediately retry TX -> switch to RX -> timeout again. Rapid TX-RX-TX cycling with no recovery period.

TX power is set to 0xfdfdfdfd (near max), which draws high current during TX bursts. The rapid TX-RX switching creates current transients that destabilize the PLL on the DW3110's clock synthesizer.

### Root Cause Analysis

The DW3110 PLL requires stable supply voltage during TX-RX transitions. The initiator pattern causes:

1. TX POLL: high current draw (~100-150mA for the PA)
2. Switch to RX: current drops sharply
3. PLL must re-lock for RX frequency -- sensitive to supply noise during this transition
4. If PLL doesn't lock, SPI transactions also fail (SPI CRC error)
5. RX times out, firmware immediately retries TX, repeating the unstable cycle

Anchors don't hit this because their TX events are spaced apart by the tag's poll interval (100-200ms), giving the PLL ample time to stabilize in idle RX between transmissions.

### Firmware Mitigations (partial)

These reduce the failure rate but don't eliminate the issue:

- `dwt_forcetrxoff()` + 5ms delay before each poll (forces clean radio state)
- Increased poll interval to 200ms (more recovery time between anchors)
- Minimum 5ms floor on poll interval to prevent 0ms fast mode from locking up

### Hardware Fix (Next Revision)

1. **Add bypass capacitors on DW3110 VDDPA (TX power amplifier supply):**
   - 10uF + 100nF ceramic close to VDDPA pin
   - This absorbs the TX current transients that cause voltage dips

2. **Add bypass capacitors on DW3110 VDDCLK (clock/PLL supply):**
   - 1uF + 100nF ceramic close to VDDCLK pin
   - Isolates the PLL supply from PA current transients

3. **Verify VDD decoupling matches Qorvo reference design:**
   - DW3000 datasheet section 10 specifies per-pin decoupling requirements
   - Check VDDLDO1, VDDLDO2, VDDMS, VDDIF capacitor values and placement
   - Ensure ferrite beads or LC filters between PA supply and PLL supply

4. **Consider separate LDO for DW3110:**
   - If DW3110 shares a regulator with ESP32-S3 WiFi radio, WiFi TX bursts
     also cause supply transients
   - A dedicated 1.8V LDO for DW3110 with proper input/output filtering
     would provide cleaner supply

### Verification

After hardware fix, test with:
```
# Should achieve >95% success rate with 3+ anchors at 100ms poll interval
# Current rate: <10% with 3 anchors
idf.py -p /dev/ttyACM1 monitor  # watch for PLL Losing Lock events
```

---

## HW-002: Brownout During WiFi PHY Initialization

**Status:** Confirmed, worked around with external power supply
**Severity:** Medium -- causes boot loop on USB-only power

### Symptoms

- `BOD: Brownout detector was triggered` immediately after `phy_init` (WiFi radio powerup)
- Board resets in a loop, never reaches application code
- Only occurs when powered from USB alone (some boards/hubs marginal)

### Root Cause

WiFi `phy_init` draws ~300-350mA peak. Combined with ESP32-S3 base current and DW3110, total exceeds what marginal USB sources can deliver, causing VCC to dip below brownout threshold (~3.0V at level 3).

### Current Workaround

Power boards from lab supply (3.3V or 5V), use USB only for data.

### Hardware Fix (Next Revision)

1. Add bulk capacitance (100-470uF) near ESP32-S3 VCC input
2. Ensure USB power path has low-impedance trace/connector
3. Consider a dedicated 3.3V regulator with higher current rating

---

## HW-003: USB Port Assignment Instability

**Status:** Observed, no hardware fix needed
**Severity:** Low -- operational nuisance

### Symptoms

- `/dev/ttyACM*` port numbers shift unpredictably after USB re-enumeration
- Multiple identical VID:PID (303a:1001) devices on same hub
- `esptool --after hard_reset` on one device can cause others to re-enumerate

### Workaround

- Use MAC address or LED color to identify boards (not port numbers)
- Use `--after no_reset` for flashing to avoid disturbing other devices
- RGB LED indicator: Blue=Anchor, Green=Active Tag, Red=Passive Tag (GPIO48 WS2812)
