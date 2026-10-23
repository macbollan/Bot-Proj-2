//+------------------------------------------------------------------+
//|                                              Simple_MACross.mq5  |
//|                                      High-Frequency Test EA     |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      ""
#property version   "1.00"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

CTrade         trade;
CPositionInfo  posInfo;

//-=========================================================================================
//=========================================================================================

//+------------------------------------------------------------------+
//| MASTER EA — BROADCASTER GLOBALS                                  |
//| Paste these above OnInit(). Required by BroadcastToProTrading() |
//+------------------------------------------------------------------+

input group "D.E.T Broadcaster"
input string Pro_ServerURL   = "https://bot-proj-2-1.onrender.com/api/master/update";
input string MasterSecret    = "DET_MASTER_2026_CHANGE_ME";   // MUST match server env MASTER_EA_SECRET
input bool   BroadcastVerbose = true;                          // false = only errors logged

//--- Trend / direction flags (set these in your tick handler BEFORE broadcasting)
bool   uptrend              = false;
bool   down_trend           = false;
bool   uptrend_pullback     = false;
bool   down_trend_pullback  = false;

//--- RSI value (0..100) — set this from your iRSI() buffer each tick
double rsi                  = 50.0;

//+------------------------------------------------------------------+
//| Minimal JSON string escaper (handles quotes, backslashes, CRLF)  |
//+------------------------------------------------------------------+
string JsonEscape(string s) {
    string out = "";
    int n = StringLen(s);
    for(int i = 0; i < n; i++) {
        ushort c = StringGetCharacter(s, i);
        if(c == '"')       out += "\\\"";
        else if(c == '\\') out += "\\\\";
        else if(c == '\n') out += "\\n";
        else if(c == '\r') out += "\\r";
        else if(c == '\t') out += "\\t";
        else               out += ShortToString(c);
    }
    return out;
}

//-=========================================================================================
//=========================================================================================


//--- Inputs
input group "=== Moving Average Settings ==="
input int                InpFastPeriod   = 5;              // Fast MA Period (Lower = More Frequent)
input int                InpSlowPeriod   = 13;             // Slow MA Period
input ENUM_MA_METHOD     InpMAMethod     = MODE_EMA;       // MA Method
input ENUM_APPLIED_PRICE InpAppliedPrice = PRICE_CLOSE;     // Applied Price

input group "=== Trade Settings ==="
input double             InpLotSize      = 0.01;           // Lot Size
input int                InpStopLoss     = 150;            // Stop Loss (Points, 0 = Disabled)
input int                InpTakeProfit   = 300;            // Take Profit (Points, 0 = Disabled)
input ulong              InpMagicNumber  = 998877;         // Magic Number

input group "=== Trailing Stop Settings ==="
input bool               InpUseTrailing  = true;           // Enable Trailing Stop
input int                InpTrailTrigger = 100;            // Trigger Profit to Start Trailing (Points)
input int                InpTrailStep    = 50;             // Trailing Step Distance (Points)

//--- Handles & Buffers
int fastMAHandle = INVALID_HANDLE;
int slowMAHandle = INVALID_HANDLE;
datetime lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(10);
   trade.SetTypeFilling(ORDER_FILLING_FOK);

   // Fallback check for filling mode depending on broker execution
   uint filling = (uint)SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0)
      trade.SetTypeFilling(ORDER_FILLING_FOK);
   else if((filling & SYMBOL_FILLING_IOC) != 0)
      trade.SetTypeFilling(ORDER_FILLING_IOC);
   else
      trade.SetTypeFilling(ORDER_FILLING_RETURN);

   fastMAHandle = iMA(_Symbol, _Period, InpFastPeriod, 0, InpMAMethod, InpAppliedPrice);
   slowMAHandle = iMA(_Symbol, _Period, InpSlowPeriod, 0, InpMAMethod, InpAppliedPrice);

   if(fastMAHandle == INVALID_HANDLE || slowMAHandle == INVALID_HANDLE)
   {
      Print("[INIT] Failed to create MA indicator handles.");
      return INIT_FAILED;
   }

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(fastMAHandle);
   IndicatorRelease(slowMAHandle);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Manage Trailing Stop on every tick (if enabled)
   if(InpUseTrailing)
      ApplyTrailingStop();

   // 2. Bar close check (prevents false repainting crossovers mid-candle)
   datetime currentBarTime = iTime(_Symbol, _Period, 0);
   if(currentBarTime == lastBarTime)
      return;

   // 3. Check crossover signals on completed bars (1 and 2)
   double fastMA[2], slowMA[2];
   if(CopyBuffer(fastMAHandle, 0, 1, 2, fastMA) < 2) return;
   if(CopyBuffer(slowMAHandle, 0, 1, 2, slowMA) < 2) return;

   // Index 1 = Shift 1 (last closed candle), Index 0 = Shift 2 (candle before that)
   bool bullishCross = (fastMA[0] <= slowMA[0] && fastMA[1] > slowMA[1]);
   bool bearishCross = (fastMA[0] >= slowMA[0] && fastMA[1] < slowMA[1]);

   if(bullishCross || bearishCross)
   {
      lastBarTime = currentBarTime;

      // Close opposite position or avoid stack if already holding current direction
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(posInfo.SelectByIndex(i))
         {
            if(posInfo.Symbol() == _Symbol && posInfo.Magic() == InpMagicNumber)
            {
               if((bullishCross && posInfo.PositionType() == POSITION_TYPE_SELL) ||
                  (bearishCross && posInfo.PositionType() == POSITION_TYPE_BUY))
               {
                  trade.PositionClose(posInfo.Ticket());
               }
            }
         }
      }

      // Check if position already exists for this symbol & magic
      if(!HasOpenPosition())
      {
         double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

         if(bullishCross)
         {
            double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
            double sl  = (InpStopLoss > 0)   ? (ask - InpStopLoss * point)   : 0;
            double tp  = (InpTakeProfit > 0) ? (ask + InpTakeProfit * point) : 0;

            trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "Fast MA Cross");
         }
         else if(bearishCross)
         {
            double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            double sl  = (InpStopLoss > 0)   ? (bid + InpStopLoss * point)   : 0;
            double tp  = (InpTakeProfit > 0) ? (bid - InpTakeProfit * point) : 0;

            trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "Fast MA Cross");
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Check if an active position exists under this magic number       |
//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(posInfo.SelectByIndex(i))
      {
         if(posInfo.Symbol() == _Symbol && posInfo.Magic() == InpMagicNumber)
            return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Trailing stop logic (runs tick by tick)                          |
//+------------------------------------------------------------------+
void ApplyTrailingStop()
{
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(posInfo.SelectByIndex(i))
      {
         if(posInfo.Symbol() == _Symbol && posInfo.Magic() == InpMagicNumber)
         {
            ulong ticket = posInfo.Ticket();
            double openPrice = posInfo.PriceOpen();
            double currentSL = posInfo.StopLoss();
            double currentPrice = (posInfo.PositionType() == POSITION_TYPE_BUY) ? 
                                  SymbolInfoDouble(_Symbol, SYMBOL_BID) : 
                                  SymbolInfoDouble(_Symbol, SYMBOL_ASK);

            if(posInfo.PositionType() == POSITION_TYPE_BUY)
            {
               // Check if profit exceeded trigger threshold
               if((currentPrice - openPrice) > (InpTrailTrigger * point))
               {
                  double newSL = currentPrice - (InpTrailStep * point);
                  // Ensure trail moves up only
                  if(newSL > currentSL + (point * 5))
                  {
                     trade.PositionModify(ticket, newSL, posInfo.TakeProfit());
                  }
               }
            }
            else if(posInfo.PositionType() == POSITION_TYPE_SELL)
            {
               // Check if profit exceeded trigger threshold
               if((openPrice - currentPrice) > (InpTrailTrigger * point))
               {
                  double newSL = currentPrice + (InpTrailStep * point);
                  // Ensure trail moves down only
                  if(newSL < currentSL - (point * 5) || currentSL == 0)
                  {
                     trade.PositionModify(ticket, newSL, posInfo.TakeProfit());
                  }
               }
            }
         }
      }
   }
}





//=====================================================================================================================
//=====================================================================================================================
//=====================================================================================================================
//+------------------------------------------------------------------+
//| Broadcast master state → D.E.T server                            |
//| Returns true on HTTP 200, false on any failure.                  |
//|                                                                  |
//| throttleSeconds: 0 = send every call (same as your original).    |
//| Pass 2–5 if you call this from OnTick to avoid hammering.        |
//+------------------------------------------------------------------+
bool BroadcastToProTrading(int throttleSeconds = 0) {
    // ── Optional throttle ─────────────────────────────────────────
    static datetime lastSend = 0;
    if(throttleSeconds > 0 && (TimeCurrent() - lastSend) < throttleSeconds)
        return true;
    lastSend = TimeCurrent();

    // ── Snapshot account / symbol ─────────────────────────────────
    int    openTrades    = PositionsTotal();
    double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
    double currentPrice  = SymbolInfoDouble(_Symbol, SYMBOL_BID);

    // ── 1. Build trades array ─────────────────────────────────────
    string tradesArray = "[";
    bool   first       = true;
    for(int i = 0; i < PositionsTotal(); i++) {
        ulong ticket = PositionGetTicket(i);
        if(ticket == 0)                 continue;
        if(!PositionSelectByTicket(ticket)) continue;

        string sym       = PositionGetString(POSITION_SYMBOL);
        long   ptype     = PositionGetInteger(POSITION_TYPE);
        double vol       = PositionGetDouble(POSITION_VOLUME);
        double priceOpen = PositionGetDouble(POSITION_PRICE_OPEN);
        double sl        = PositionGetDouble(POSITION_SL);
        double tp        = PositionGetDouble(POSITION_TP);

        string typeStr   = (ptype == POSITION_TYPE_BUY) ? "BUY" : "SELL";

        if(!first) tradesArray += ",";
        tradesArray += StringFormat(
            "{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\","
            "\"volume\":%.2f,\"open_price\":%.5f,\"sl\":%.5f,\"tp\":%.5f}",
            ticket, JsonEscape(sym), typeStr, vol, priceOpen, sl, tp);
        first = false;
    }
    tradesArray += "]";

    // ── 2. Trend & action strings ─────────────────────────────────
    string trend  = "Algo Active";
    string action = (openTrades > 0)
        ? StringFormat("Managing %d Trades", openTrades)
        : "Scanning Markets";

    // ── 3. UI state block ─────────────────────────────────────────
    string trends = StringFormat(
        "\"trends\":{\"long\":\"%s\",\"swing\":\"%s\",\"day\":\"%s\","
        "\"intra\":\"%s\",\"scalpa\":\"%s\",\"real\":\"%s\"}",
        (uptrend || down_trend) ? "Active" : "Monitoring",
        (uptrend_pullback || down_trend_pullback) ? "Pullback" : "Stable",
        "Active",
        "Active",
        "Monitoring",
        "Live");

    string analytics = StringFormat(
        "\"analytics\":{\"scalpa\":\"%s\",\"intra\":\"%s\",\"day\":\"%s\","
        "\"swing\":\"%s\",\"long\":\"%s\"}",
        rsi > 70 ? "Overbought" : (rsi < 30 ? "Oversold" : "Neutral"),
        "Monitoring",
        "Monitoring",
        "Monitoring",
        "Monitoring");

    string uiState = "\"uiState\":{" + trends + "," + analytics + "}";

    // ── 4. Full JSON payload ──────────────────────────────────────
    string json = StringFormat(
        "{\"masterPassword\":\"%s\","
        "\"analysis\":{\"symbol\":\"%s\",\"trend\":\"%s\",\"action\":\"%s\","
        "\"price\":%.5f,\"equity\":%.2f,\"openTrades\":%d},"
        "\"trades\":%s,%s}",
        JsonEscape(MasterSecret),
        JsonEscape(_Symbol),
        JsonEscape(trend),
        JsonEscape(action),
        currentPrice,
        currentEquity,
        openTrades,
        tradesArray,
        uiState);

    // ── 5. POST it ────────────────────────────────────────────────
    char   postData[], responseData[];
    string headers = "Content-Type: application/json\r\n";

    StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
    if(ArraySize(postData) > 0)
        ArrayResize(postData, ArraySize(postData) - 1); // strip null terminator

    string responseHeaders;
    ResetLastError();
    int httpStatus = WebRequest("POST", Pro_ServerURL, headers, 5000,
                                postData, responseData, responseHeaders);
    int err = GetLastError();

    // ── 6. Handle transport-level failures ────────────────────────
    if(httpStatus == -1) {
        if(err == 4014)
            Print("[BROADCAST] ❌ URL NOT ALLOWED. Add ", Pro_ServerURL,
                  " to Tools → Options → Expert Advisors → Allow WebRequest, then restart the EA.");
        else if(err == 4013)
            Print("[BROADCAST] ❌ WebRequest timeout (5 s). Server slow or unreachable.");
        else if(err == 4016)
            Print("[BROADCAST] ❌ No internet connection.");
        else
            Print("[BROADCAST] ❌ WebRequest failed. Error code: ", err);
        return false;
    }

    // ── 7. Handle HTTP responses ──────────────────────────────────
    string response = CharArrayToString(responseData);

    if(httpStatus == 200) {
        static int successCount = 0;
        successCount++;
        // First 3 sends always logged; then every 30th — avoids log spam.
        if(BroadcastVerbose && (successCount <= 3 || successCount % 30 == 0)) {
            Print("[BROADCAST] ✅ ", _Symbol,
                  " | price=",  DoubleToString(currentPrice, 5),
                  " | equity=", DoubleToString(currentEquity, 2),
                  " | trades=", openTrades,
                  " | resp=",   response);
        }
        return true;
    }

    if(httpStatus == 401) {
        Print("[BROADCAST] ❌ HTTP 401 — masterPassword mismatch. ",
              "Check MasterSecret matches MASTER_EA_SECRET on server. Body: ", response);
    } else if(httpStatus == 500) {
        Print("[BROADCAST] ❌ HTTP 500 — server error. Body: ", response);
    } else {
        Print("[BROADCAST] ❌ HTTP ", httpStatus, " — body: ", response);
    }

    return false;
}

//+------------------------------------------------------------------+
//| UpdateTrendFlags — self-contained (creates its own handles once)  |
//+------------------------------------------------------------------+
void UpdateTrendFlags() {
    static int h_ema20 = INVALID_HANDLE;
    static int h_ema50 = INVALID_HANDLE;
    static int h_rsi   = INVALID_HANDLE;

    if(h_ema20 == INVALID_HANDLE)
        h_ema20 = iMA(_Symbol, _Period, 20, 0, MODE_EMA, PRICE_CLOSE);
    if(h_ema50 == INVALID_HANDLE)
        h_ema50 = iMA(_Symbol, _Period, 50, 0, MODE_EMA, PRICE_CLOSE);
    if(h_rsi == INVALID_HANDLE)
        h_rsi   = iRSI(_Symbol, _Period, 14, PRICE_CLOSE);

    if(h_ema20 == INVALID_HANDLE || h_ema50 == INVALID_HANDLE || h_rsi == INVALID_HANDLE) {
        static bool warned = false;
        if(!warned) {
            Print("[TREND] ❌ Indicator handle creation failed. err=", GetLastError());
            warned = true;
        }
        return;
    }

    double ema20_buf[], ema50_buf[], rsi_buf[];
    if(CopyBuffer(h_ema20, 0, 0, 1, ema20_buf) <= 0) return;
    if(CopyBuffer(h_ema50, 0, 0, 1, ema50_buf) <= 0) return;
    if(CopyBuffer(h_rsi,   0, 0, 1, rsi_buf)   <= 0) return;

    double close = SymbolInfoDouble(_Symbol, SYMBOL_BID);

    uptrend     = (ema20_buf[0] > ema50_buf[0]) && (close > ema20_buf[0]);
    down_trend  = (ema20_buf[0] < ema50_buf[0]) && (close < ema20_buf[0]);

    uptrend_pullback    = uptrend    && (close < ema20_buf[0]);
    down_trend_pullback = down_trend && (close > ema20_buf[0]);

    rsi = rsi_buf[0];
}
//=====================================================================================================================
//=====================================================================================================================
//=====================================================================================================================