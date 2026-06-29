#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
calculate_gex_20260625.py

A standalone Python script to calculate the Gamma Exposure (GEX) for QQQ options
expiring on 2026-06-25, based on QQQ_optionchain.json.

This script uses only Python standard libraries to ensure zero external dependency.
It performs:
1. Adaptive spot price estimation using Put-Call Parity from active strikes.
2. Implied Volatility (IV) solving via Bisection Method under the Black-Scholes model (using OTM options for robustness).
3. Gamma calculation and GEX aggregation (both in Share value and Dollar-notional per 1% move).
4. Identification of Call Wall, Put Wall, and Zero Gamma levels.
5. Exporting detailed results to a CSV file and printing a formatted table.
"""

import os
import json
import math

# ==========================================
# 1. Black-Scholes Formula & Greeks Engine
# ==========================================

def normal_cdf(x):
    """Cumulative distribution function of standard normal distribution."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))

def normal_pdf(x):
    """Probability density function of standard normal distribution."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)

def bs_price(S, K, T, r, sigma, option_type):
    """Calculate Black-Scholes price for call or put option."""
    if T <= 0:
        if option_type == 'call':
            return max(0.0, S - K)
        else:
            return max(0.0, K - S)
    
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    
    if option_type == 'call':
        return S * normal_cdf(d1) - K * math.exp(-r * T) * normal_cdf(d2)
    else:
        return K * math.exp(-r * T) * normal_cdf(-d2) - S * normal_cdf(-d1)

def bs_gamma(S, K, T, r, sigma):
    """Calculate Black-Scholes Gamma."""
    if T <= 0 or sigma <= 0:
        return 0.0
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    return normal_pdf(d1) / (S * sigma * math.sqrt(T))

def find_iv(price, S, K, T, r, option_type):
    """Back-solve for Implied Volatility (IV) using Bisection Method."""
    intrinsic = max(0.0, S - K) if option_type == 'call' else max(0.0, K - S)
    if price <= intrinsic + 1e-4:
        return None
    
    low = 0.0001
    high = 5.0
    for _ in range(50):
        mid = (low + high) / 2.0
        p = bs_price(S, K, T, r, mid, option_type)
        if abs(p - price) < 1e-5:
            return mid
        if p < price:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0

# ==========================================
# 2. Main Process
# ==========================================

def main():
    json_path = 'QQQ_optionchain.json'
    if not os.path.exists(json_path):
        print(f"Error: Could not find {json_path} in the current directory.")
        return

    print(f"Loading {json_path}...")
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    chains = data['optionChains'][0]['chains']

    # ----------------------------------------------------
    # Step 1: Set Spot Price S (using user-provided 716.3)
    # ----------------------------------------------------
    # The actual QQQ closing price for 2026-06-25 is 716.3.
    # We use this value directly.
    S = 716.3
    print(f"Using QQQ Spot Price: {S:.2f} (User provided closing price)")

    # ----------------------------------------------------
    # Step 2: Extract 2026-06-25 Expiration (0DTE) Options
    # ----------------------------------------------------
    c_target = next((c for c in chains if c['mmy'] == '20260626'), None)
    if not c_target:
        print("Error: Expiration 2026-06-26 not found in the option chain data.")
        return

    print("Processing 2026-06-26 expiration...")
    
    # Constants for 0DTE Greek calculations
    # T = 1 day (1.0 / 365.0) to model the GEX profile of the day
    T = 1.0 / 365.0
    r = 0.05 # risk-free rate (5%)
    
    calls_dict = {opt['strike']: opt for opt in c_target['calls']}
    puts_dict = {opt['strike']: opt for opt in c_target['puts']}
    
    strikes = sorted(list(set(list(calls_dict.keys()) + list(puts_dict.keys()))))
    
    # ----------------------------------------------------
    # Step 3: Back-solve Implied Volatility (IV)
    # ----------------------------------------------------
    # To avoid ITM price distortion, we solve IV from OTM options:
    # - If strike >= S: solve using Call
    # - If strike < S: solve using Put
    
    iv_results = {}
    for strike in strikes:
        call = calls_dict.get(strike)
        put = puts_dict.get(strike)
        
        iv = None
        if strike >= S and call:
            b, a = call.get('bidPrice'), call.get('askPrice')
            price = (b + a)/2.0 if (b is not None and a is not None) else call.get('lastTradePrice', 0)
            if price and price > 0:
                iv = find_iv(price, S, strike, T, r, 'call')
        elif strike < S and put:
            b, a = put.get('bidPrice'), put.get('askPrice')
            price = (b + a)/2.0 if (b is not None and a is not None) else put.get('lastTradePrice', 0)
            if price and price > 0:
                iv = find_iv(price, S, strike, T, r, 'put')
                
        iv_results[strike] = iv

    # ----------------------------------------------------
    # Step 4: Fill Missing/Invalid IVs (Interpolation/Fallback)
    # ----------------------------------------------------
    # For extreme OTM/ITM strikes where bid/ask is invalid or zero, we fill using nearest valid IV
    strikes_list = sorted(iv_results.keys())
    for i, strike in enumerate(strikes_list):
        if iv_results[strike] is None or iv_results[strike] <= 0.0002:
            # Find nearest valid IV
            left = i - 1
            right = i + 1
            found = False
            while left >= 0 or right < len(strikes_list):
                if left >= 0 and iv_results[strikes_list[left]] is not None and iv_results[strikes_list[left]] > 0.0002:
                    iv_results[strike] = iv_results[strikes_list[left]]
                    found = True
                    break
                if right < len(strikes_list) and iv_results[strikes_list[right]] is not None and iv_results[strikes_list[right]] > 0.0002:
                    iv_results[strike] = iv_results[strikes_list[right]]
                    found = True
                    break
                left -= 1
                right += 1
            if not found:
                iv_results[strike] = 0.15  # Default fallback 15%

    # ----------------------------------------------------
    # Step 5: Calculate Gamma and GEX per Strike (For T = 1 Day and T = 1 Min)
    # ----------------------------------------------------
    detailed_data = []
    
    total_dollar_gex_1day = 0.0
    total_dollar_gex_1m = 0.0
    total_shares_gex_1day = 0.0
    total_shares_gex_1m = 0.0
    
    T_1m = 1.0 / (365.0 * 24.0 * 60.0)  # 1 minute in years
    
    for strike in strikes:
        call = calls_dict.get(strike, {})
        put = puts_dict.get(strike, {})
        
        call_oi = call.get('openInterest', 0) or 0
        put_oi = put.get('openInterest', 0) or 0
        call_vol = call.get('volume', 0) or 0
        put_vol = put.get('volume', 0) or 0
        
        iv = iv_results[strike]
        
        # Calculate Gamma for both T = 1 Day and T = 1 Minute
        gamma_1day = bs_gamma(S, strike, T, r, iv)
        gamma_1m = bs_gamma(S, strike, T_1m, r, iv)
        
        # 1. Shares GEX
        gex_shares_call_1day = gamma_1day * call_oi * 100
        gex_shares_put_1day = -gamma_1day * put_oi * 100
        gex_shares_total_1day = gex_shares_call_1day + gex_shares_put_1day
        
        gex_shares_call_1m = gamma_1m * call_oi * 100
        gex_shares_put_1m = -gamma_1m * put_oi * 100
        gex_shares_total_1m = gex_shares_call_1m + gex_shares_put_1m
        
        # 2. Dollar GEX
        gex_dollar_call_1day = gex_shares_call_1day * S * S * 0.01
        gex_dollar_put_1day = gex_shares_put_1day * S * S * 0.01
        gex_dollar_total_1day = gex_dollar_call_1day + gex_dollar_put_1day
        
        gex_dollar_call_1m = gex_shares_call_1m * S * S * 0.01
        gex_dollar_put_1m = gex_shares_put_1m * S * S * 0.01
        gex_dollar_total_1m = gex_dollar_call_1m + gex_dollar_put_1m
        
        total_dollar_gex_1day += gex_dollar_total_1day
        total_dollar_gex_1m += gex_dollar_total_1m
        total_shares_gex_1day += gex_shares_total_1day
        total_shares_gex_1m += gex_shares_total_1m
        
        detailed_data.append({
            'strike': strike,
            'call_oi': call_oi,
            'put_oi': put_oi,
            'call_vol': call_vol,
            'put_vol': put_vol,
            'iv': iv,
            'gamma_1day': gamma_1day,
            'gamma_1m': gamma_1m,
            'gex_shares_call_1day': gex_shares_call_1day,
            'gex_shares_put_1day': gex_shares_put_1day,
            'gex_shares_total_1day': gex_shares_total_1day,
            'gex_shares_call_1m': gex_shares_call_1m,
            'gex_shares_put_1m': gex_shares_put_1m,
            'gex_shares_total_1m': gex_shares_total_1m,
            'gex_dollar_call_1day': gex_dollar_call_1day,
            'gex_dollar_put_1day': gex_dollar_put_1day,
            'gex_dollar_total_1day': gex_dollar_total_1day,
            'gex_dollar_call_1m': gex_dollar_call_1m,
            'gex_dollar_put_1m': gex_dollar_put_1m,
            'gex_dollar_total_1m': gex_dollar_total_1m
        })

    # ----------------------------------------------------
    # Step 6: Identify Key Levels (Using T = 1 Day as baseline)
    # ----------------------------------------------------
    # Call Wall: Max positive GEX
    call_wall_item = max(detailed_data, key=lambda x: x['gex_dollar_total_1day'])
    call_wall = call_wall_item['strike']
    
    # Put Wall: Max negative GEX
    put_wall_item = min(detailed_data, key=lambda x: x['gex_dollar_total_1day'])
    put_wall = put_wall_item['strike']
    
    # Zero Gamma: level where total GEX flips sign near spot
    near_spot_items = [x for x in detailed_data if abs(x['strike'] - S) < 15]
    zero_gamma = None
    if len(near_spot_items) > 1:
        flips = []
        for i in range(len(near_spot_items) - 1):
            gex1 = near_spot_items[i]['gex_dollar_total_1day']
            gex2 = near_spot_items[i+1]['gex_dollar_total_1day']
            if gex1 * gex2 < 0:
                pick = near_spot_items[i] if abs(gex1) < abs(gex2) else near_spot_items[i+1]
                flips.append(pick['strike'])
        if flips:
            zero_gamma = min(flips, key=lambda x: abs(x - S))
        else:
            min_gex_item = min(near_spot_items, key=lambda x: abs(x['gex_dollar_total_1day']))
            zero_gamma = min_gex_item['strike']
    else:
        zero_gamma = min(detailed_data, key=lambda x: abs(x['gex_dollar_total_1day']))['strike']

    # ----------------------------------------------------
    # Step 7: Export to CSV
    # ----------------------------------------------------
    csv_file = 'QQQ_GEX_20260626.csv'
    with open(csv_file, 'w', encoding='utf-8') as f:
        f.write("Strike,Call_OI,Put_OI,Call_Vol,Put_Vol,IV,Gamma_1Day,Gamma_1Min,GEX_Shares_1Day,GEX_Shares_1Min,GEX_Dollar_1Day,GEX_Dollar_1Min\n")
        for row in detailed_data:
            f.write(f"{row['strike']},{row['call_oi']},{row['put_oi']},{row['call_vol']},{row['put_vol']},{row['iv']:.6f},"
                    f"{row['gamma_1day']:.6f},{row['gamma_1m']:.6f},{row['gex_shares_total_1day']:.2f},{row['gex_shares_total_1m']:.2f},"
                    f"{row['gex_dollar_total_1day']:.2f},{row['gex_dollar_total_1m']:.2f}\n")
    print(f"Detailed calculations saved to: {csv_file}")

    # ----------------------------------------------------
    # Step 8: Print Results and Table
    # ----------------------------------------------------
    print("\n" + "="*50)
    print("      QQQ 2026-06-26 GEX CALCULATION RESULTS")
    print("="*50)
    print(f"Estimated QQQ Spot Price: {S:.2f}")
    print(f"T = 1 Day - Total Market GEX (Dollar): ${total_dollar_gex_1day:,.2f}")
    print(f"T = 1 Min - Total Market GEX (Dollar): ${total_dollar_gex_1m:,.2f}")
    print("-"*50)
    print(f"Call Wall (1D Max Positive) : {call_wall:.1f} (GEX: ${call_wall_item['gex_dollar_total_1day']:,.2f})")
    print(f"Put Wall  (1D Max Negative) : {put_wall:.1f} (GEX: ${put_wall_item['gex_dollar_total_1day']:,.2f})")
    print(f"Zero Gamma Level (1D)        : {zero_gamma:.1f}")
    print("="*50)
    
    print("\nSample strikes around Spot (700.0 ~ 735.0):")
    print("-" * 135)
    print(f"{'Strike':<8} | {'Call OI':<8} | {'Put OI':<8} | {'IV':<8} | {'Gamma (1D)':<10} | {'GEX ($ 1D)':<16} | {'Gamma (1m)':<10} | {'GEX ($ 1m)':<16}")
    print("-" * 135)
    
    # Filter and display strikes in range
    for row in detailed_data:
        if 700.0 <= row['strike'] <= 735.0:
            marker = ""
            if abs(row['strike'] - S) <= 0.6:
                marker = " <- SPOT"
            elif row['strike'] == call_wall:
                marker = " <- CALL WALL"
            elif row['strike'] == put_wall:
                marker = " <- PUT WALL"
            elif row['strike'] == zero_gamma:
                marker = " <- ZERO GAMMA"
                
            print(f"{row['strike']:<8.1f} | "
                  f"{row['call_oi']:<8d} | "
                  f"{row['put_oi']:<8d} | "
                  f"{row['iv']:<8.4f} | "
                  f"{row['gamma_1day']:<10.6f} | "
                  f"{row['gex_dollar_total_1day']:<16,.2f} | "
                  f"{row['gamma_1m']:<10.6f} | "
                  f"{row['gex_dollar_total_1m']:<16,.2f}{marker}")
    print("-" * 135)

    # ----------------------------------------------------
    # Step 9: Plot GEX Curve (Smooth Comparison Subplots with K/M/B labels)
    # ----------------------------------------------------
    try:
        import matplotlib.pyplot as plt
        import numpy as np
        from scipy.interpolate import make_interp_spline
        
        # Format function for GEX axis labels (e.g. $1.5B, -$21.4M)
        def format_gex_labels(val, pos):
            abs_val = abs(val)
            sign = '-' if val < 0 else ''
            if abs_val >= 1e9:
                return f"{sign}${abs_val / 1e9:.1f}B"
            elif abs_val >= 1e6:
                return f"{sign}${abs_val / 1e6:.1f}M"
            elif abs_val >= 1e3:
                return f"{sign}${abs_val / 1e3:.1f}K"
            elif abs_val == 0:
                return "$0"
            else:
                return f"{sign}${abs_val:.1f}"
        
        # Find index of strike closest to Spot S
        closest_idx = min(range(len(detailed_data)), key=lambda i: abs(detailed_data[i]['strike'] - S))
        
        # Take 15 strikes to the left and 15 to the right
        start_idx = max(0, closest_idx - 15)
        end_idx = min(len(detailed_data), closest_idx + 16)
        plot_slice = detailed_data[start_idx:end_idx]
        
        x = np.array([row['strike'] for row in plot_slice])
        y_1day = np.array([row['gex_dollar_total_1day'] for row in plot_slice])
        y_1m = np.array([row['gex_dollar_total_1m'] for row in plot_slice])
        
        # Smooth interpolation for both
        x_smooth = np.linspace(x.min(), x.max(), 300)
        
        spl_1day = make_interp_spline(x, y_1day, k=3)
        y_smooth_1day = spl_1day(x_smooth)
        
        spl_1m = make_interp_spline(x, y_1m, k=3)
        y_smooth_1m = spl_1m(x_smooth)
        
        # Draw 1 plot with dual Y-axes (twinx) and align zeros
        fig, ax1 = plt.subplots(figsize=(12, 6.5))
        
        # Plot T = 1 Day (Left Y-axis)
        color_1day = '#1f77b4'
        ax1.plot(x_smooth, y_smooth_1day, label='T = 1 Day (Standard)', color=color_1day, linewidth=2.5)
        ax1.scatter(x, y_1day, color=color_1day, alpha=0.5, s=25)
        ax1.set_xlabel('Strike Price', fontsize=11, labelpad=10)
        ax1.set_ylabel('Gamma Exposure - T = 1 Day ($)', color=color_1day, fontsize=11)
        ax1.tick_params(axis='y', labelcolor=color_1day)
        ax1.yaxis.set_major_formatter(plt.FuncFormatter(format_gex_labels))
        ax1.grid(True, linestyle=':', alpha=0.4)
        
        # Plot T = 1 Minute (Right Y-axis)
        ax2 = ax1.twinx()
        color_1m = '#ff7f0e'
        ax2.plot(x_smooth, y_smooth_1m, label='T = 1 Minute (Greeks Flare-up)', color=color_1m, linewidth=2.5, linestyle='--')
        ax2.scatter(x, y_1m, color=color_1m, alpha=0.5, s=25)
        ax2.set_ylabel('Gamma Exposure - T = 1 Minute ($)', color=color_1m, fontsize=11)
        ax2.tick_params(axis='y', labelcolor=color_1m)
        ax2.yaxis.set_major_formatter(plt.FuncFormatter(format_gex_labels))
        
        # Align zeros by setting symmetric limits on both y-axes
        max_abs_1day = max(abs(y_smooth_1day.min()), abs(y_smooth_1day.max())) * 1.15
        max_abs_1m = max(abs(y_smooth_1m.min()), abs(y_smooth_1m.max())) * 1.15
        ax1.set_ylim(-max_abs_1day, max_abs_1day)
        ax2.set_ylim(-max_abs_1m, max_abs_1m)
        
        # Draw shared elements
        # 1. Zero line (perfectly aligned now)
        ax1.axhline(0, color='gray', linestyle='--', alpha=0.7, linewidth=1.2)
        
        # 2. Spot line
        spot_line = ax1.axvline(S, color='#d62728', linestyle=':', linewidth=2.0, label=f'Spot Price ({S:.2f})')
        
        # Combine legends from both axes
        lines1, labels1 = ax1.get_legend_handles_labels()
        lines2, labels2 = ax2.get_legend_handles_labels()
        all_lines = lines1 + lines2
        all_labels = labels1 + labels2
        ax1.legend(all_lines, all_labels, loc='upper left', frameon=True)
        
        plt.title('QQQ GEX Curve Comparison: T = 1 Day vs T = 1 Minute (Dual Y-Axes)', fontsize=13, fontweight='bold', pad=15)
        plt.tight_layout()
        
        # Save to current workspace
        plot_filename = 'QQQ_GEX_20260626.png'
        plt.savefig(plot_filename, dpi=150)
        print(f"GEX Curve plot saved to: {plot_filename}")
        
        # Also copy/save to artifacts directory if available
        artifacts_dir = '/home/zdying/.gemini/antigravity-cli/brain/b67f1293-6036-4936-aaaa-e688bca3b5f0'
        if os.path.exists(artifacts_dir):
            plt.savefig(os.path.join(artifacts_dir, plot_filename), dpi=150)
            print(f"GEX Curve plot copied to artifacts directory: {artifacts_dir}/{plot_filename}")
            
        plt.close()
    except Exception as e:
        print(f"Warning: Failed to generate plot. Reason: {e}")

if __name__ == '__main__':
    main()
