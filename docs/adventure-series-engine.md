# Summit Adventure Series — Pricing Engine Spec (extracted from Excel v73)

Source: `Summit Sensory Gym START - PSF - Single Quote - v73 (25) - Claude Test-Adventure Series.xlsx`
Tabs: `bryan@…` (customer/freight/tax input) · `VLOOKUP` (questions+part logic) · `Calcs` (parts→price/weight) · `Adventure Series Proposal (USA)` (filtered output) · `lists` (SKU master) · `Resilite Mat Cost List`.

## Flow
1. Enter customer + dims + freight/tax on input tab.
2. `VLOOKUP` tab: D = question, E = answer. Answers drive a config code and part-quantity formulas (H:R region).
3. `Calcs` tab: each part row computes ORDER QUANTITY (E/F) from the VLOOKUP logic, PRICE PER PART (G = `VLOOKUP(part, lists!I:L, 4)`), WEIGHT PER PART (O), TOTAL (J = qty×price). Subtotals by category: Frame, Trolley, Sensory Gym Accessories.
4. `Proposal (USA)`: filters to qty>0 rows and lays them out in the grouped proposal.

## Questions (VLOOKUP D/E) → drive logic
- Design Layout (Rectangle/Square/L Shape/T Shape) → config prefix SQ-/R-/L-/T-
- Monkey Bars (Yes/No) → +MB; # Monkey Bar Sets
- # Legs (4/6/8) ; # Ladders (0–4) → L0..L4
- Trolley System (Yes/No) → T ; Size LENGTH/WIDTH/HEIGHT ft
- Interior Beams (+1 if monkey bars)
- Zip Line, Frame Mount Ball Rack, Slide (+Gray Upcharge, Steamroller→auto Conversion Kit)
- Climbing Wall (Frame Mounted / Wall Mounted / Safety Shield / Mat)
- Adventure Mat System: Floor / Column / Ladder Leg / Custom
- Accessory Brackets: # brackets, # 360 swivel (≤brackets), # 3/8" non-swivel = brackets−swivel, # 1/2" forged, # swing hanger (packs of 2), # V-rings (10pk), Auto-Locking Carabiner (4pk) = (forged+swivel)/4, Webbing Sling

## Beam quantity logic (key)
- Legs from config: 4/6/8 (by length range in decision doc; here chosen directly).
- SHORT beams (end caps) by WIDTH (6→P-2206, 7→P-2545/P-2207, 8→A-2408, 9→A-2409, 10→A-2410), qty 2 each.
- LONG beams by LENGTH, qty = (legs-derived count) − short-beam total.
- Interior/monkey-bar members chosen by length & config.

## SKU master (lists tab) — PART# · DESCRIPTION · price col L (Goldberg) [trolley uses col M]
A-2245 Vertical Tall <80 w/Gusset — 242.5 (wt 68.25)
A-2241 Corner Post 1-Way — 73 (11.886)
A-2242 Corner Post 2-Way — 76.5 (14.932)
A-2243 Corner Post 3-Way — 97 (17.979)
A-2244 Corner Post 4-Way — 101 (21.025)
A-2246 Vertical Tall w/Gussets,Rungs&Handles — 242.5 (67.29)
A-2225 Mid Span 1-Way Saddle — 46 (6.46)
A-2253 Single Leg Inner Ladder Sleeve — 65.5 (4.49)
A-2248 Double Leg Ladder Sleeve — 79 (10.51)
P-2545 5' Full Bay HSS w/Logo — 150 (30) ; P-2206 6' — 150 (35.8) ; P-2207 7' — 150 (42.5)
A-2408 8' Half Bay — 190 (49.26) ; A-2409 9' — 200 (56.01) ; A-2410 10' — 200 (67.9)
P-2330 Monkey Bar w/4 holes — 20.5 (2.39)
P-2216 6' Full Bay Monkey Bar — 150 (34.85) ; P-2217 7' — 150 (41.41)
A-2418 8' Half Bay Monkey Bar — 190 (47.97) ; A-2419 9' — 200 (54.53) ; A-2420 10' — 200 (66.22)
P-2124 Accessory Saddle / Quick Shift Saddle Bracket — 51 (4.83)
P-2018 Trolley Bar — 14 ; P-2025 Trolley Bar Plate — 12
P-2024 Zip Line HSS Tube — 20 (5.63) ; A-2530 Zip Line Collar — 53 (4.5)
P-2028 Base Plate Shield — 25 (2.81)
P-2500 Climbing Wall Shield — 52 (24.5) ; P-2501 Ladder Top Shield 90° — 52 (22) ; P-2502 50° — 52 (22.3)
A-2349 Steamroller Conversion Kit (ext ladder rung) — 81
SSG-SA-CFM Climbing Wall Frame Mounted (w/holds) — 825 ; SSG-SA-CWM Wall Mounted — 1062
K-5000 Ball Rack Kit — 192
Trolley rails (col M): TR2000-A10 215.1 · A09 193.16 · A08 170.72 · A07 151.2 · TRT2001 Trolley 93.49 · TRN2016 End Cap 46.75 · TRH2005 Rod Hanger 99.66
Slide: A-2216 Summit Adventure Slide 252 ; scoop slide 136 ; WS8203 Gray Upcharge 347 ; 150045 Steamroller Ramp 977 (3rd party)
Hardware bagged letters (per-each prices) in lists rows 52–80.

## Markups / tax (Calcs)
- M1 = tax 6.5% ; M2 = markup 1.3 (30%). "Price per w Tax" = price×1.065. "PRICE PER PART" col L = ROUND(cost×1.3,2) in some rows.
- **OPEN: confirm which number is the customer selling price** (list col L as-is, vs cost×markup, vs "Selling Price" col N).

## Freight
- Total weight = SUM of (qty × weight-per-part) across all included parts (Calcs col O × F).
- Freight determined from total weight (method/table on input tab — needs confirmation).

## Beam calculator (VLOOKUP tab H:R) — qty per part flows to Calcs via VLOOKUP!H:R col 11 (col R = TOTAL)
Per part#, TOTAL qty = SUM(J:N) + SUM(O:P). Columns encode contributions:
- Verticals A-2245: J = legs-based (E6=4→4, =6→6, =8→8); P = −E7 (ladders reduce). A-2246 (w/rungs): P = E7 (ladders add).
- Corner posts A-2242 2-way = 4 if legs>0; A-2243 3-way (K = 2 if legs 6, L = 4 if legs 8); L-Shape adjustments in col M.
- Mid Span A-2225: N = interiorBeams×2; O = 2 if monkey bars.
- Ladder legs P-2531 = E7; single/double sleeves by ladders.
- Full/half-bay HSS members (5'..10'): qty via short-beam (end-cap) table $D$58:$E$63 by WIDTH + long-beam table $D$67:$E$72 by LENGTH; N = interior beam member sized by length; O = monkey-bar member offsets.
  - SHORT BEAMS (end caps), qty 2 each by WIDTH: 6→P-2206, 7→P-2545, 7→P-2207, 8→A-2408, 9→A-2409, 10→A-2410.
  - LONG BEAMS by LENGTH: member qty = (legs long-count) − short-beam total.
- Monkey bar rungs P-2330: O = 9 if monkey bars; P = E7×5 (ladders). Zip line P-2024 = 2 if zip. Base Plate Shield P-2028 = verticals×2.
- Trolley parts (if Trolley=Yes): P-2018 Trolley Bar 1, P-2025 Plate 2, rail by length, TRH2005 ×6, TRN2016 ×4, TRT2001 ×2.
NOTE: port these formulas verbatim — beam count correctness is the single most critical output.

## Mat system + Resilite
- Mat SKU chosen by config code (e.g. `SQ-R-SSA-1010CLM`). Detailed mat-SKU logic to be provided by user.
- Resilite Mat Cost List tab holds mat pricing.
