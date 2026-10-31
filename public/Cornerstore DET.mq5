//+------------------------------------------------------------------+
//|                                           CornerStore_Client.mq5 |
//|                               D.E.T S.M.A.R.T Integration Client |
//|                UI/UX v5.5 - Lot Input + Unlock Prices            |
//+------------------------------------------------------------------+
#property strict
#property version   "5.50"

#include <Trade\Trade.mqh>

CTrade trade;

input string LicenseKey      = "PASTE_YOUR_9_DIGIT_DET_ID_HERE";
input string SyncURL         = "https://bot-proj-2-1.onrender.com/api/client/sync";

input group "Panel & Timing"
input bool   EnableDrag      = true;
input int    PanelWidth      = 780;
input int    SyncIntervalSec = 2;

input group "Manual Trading"
input double ManualLotSize   = 0.1;

//--- master tickets we've observed across syncs (for safe copy-exit logic)
ulong g_seenMasterTickets[];

int       g_consecutiveEmptyPolls = 0;
const int SAFE_EMPTY_THRESHOLD    = 3;   // ~6s at 2s sync interval


//--- Globals
string Prefix         = "CS_";
bool   AutoModeActive = false;
bool   OnlineStatus   = false;
bool   g_licenseValid = true;
bool   g_licenseSeen  = false;
bool   g_lockWasActive = false;
bool   g_killWasActive = false;

int UI_X = 20, UI_Y = 20, UI_W = 780;

//--- Colors
color CLR_BG          = C'8, 14, 30';
color CLR_CARD        = C'12, 24, 46';
color CLR_CARD2       = C'18, 32, 58';
color CLR_BORDER      = C'0, 210, 255';
color CLR_LINE        = C'40, 100, 155';
color CLR_MUTED       = C'150, 170, 195';
color CLR_GOLD        = C'255, 210, 40';
color CLR_PURPLE      = C'120, 40, 190';
color CLR_PURPLE2     = C'170, 60, 240';
color CLR_GREEN       = C'0, 240, 120';
color CLR_RED         = C'240, 70, 90';
color CLR_RED_BADGE   = C'230, 50, 70';
color CLR_CYAN_BADGE  = C'0, 200, 230';
color CLR_LIGHT_BLUE  = C'100, 180, 240';
color CLR_BTN_GREEN   = C'0, 200, 100';
color CLR_BTN_RED     = C'230, 50, 60';
color CLR_BTN_BLUE    = C'30, 130, 220';
color CLR_BTN_PURPLE  = C'100, 40, 180';
color CLR_BTN_DISABLED= C'60, 60, 75';
color CLR_AMBER       = C'255, 190, 60';
color CLR_BLACK       = C'0, 0, 0';

#define GRP_HDR  0
#define GRP_BODY 1

string g_font       = "Arial";
int    g_hdrH       = 44;
int    g_pad        = 10;
int    g_fullH      = 0;
int    g_collH      = 44;
bool   g_collapsed  = false;
int    g_wTile      = 130;
int    g_progW      = 200;

bool g_dragging       = false;
bool g_prevLeft       = false;
int  g_dragDX         = 0;
int  g_dragDY         = 0;
int  g_dragMaxX       = 0;
long g_prevMouseEvt   = 0;
long g_prevScroll     = 1;

string g_objs[];
int    g_objGrp[];
int    g_curGrp = 0;

string g_cName[];
string g_cText[];
color  g_cClr[];

double g_startBal          = 0;
double g_targetBal         = 0;
double g_profitTarget      = 0;   // <-- NEW
double g_totalProfit       = 0;
double g_counterProfits    = 0;
double g_unprofitableTotal = 0;

//--- NEW: current manual lot size (initialized from input, editable at runtime)
double g_lotSize = 0.1;

string g_tierName      = "AMETHYST";
string g_entryTip      = "Awaiting Data";
string g_exitTip       = "Awaiting Data";
string g_levelBtnText  = "LEVEL 3 LONGTRADER";
string g_subLicMask    = "NOT SET";
string g_brokerShort   = "Deriv";

int  g_daysRem           = 0;
int  g_hoursRem          = 0;
int  g_minsRem           = 0;
int  g_connectedBrokers  = 0;
int  g_trendCount[6];
string g_analyticsPrices[5];

int g_analyticsMaxW[5];
int g_trendMaxW[6];
int g_infoItemW        = 0;
int g_startValMaxW     = 0;
int g_gainValMaxW      = 0;
int g_subTierMaxW      = 0;
int g_subLicMaxW       = 0;
int g_statusBadgeMaxW  = 0;
int g_infoItemW5       = 0;   // 5-column bottom bar

//--- Close-attempt tracking (prevent 4756 "close order already exists")
ulong    g_closeAttemptTk[];
datetime g_closeAttemptTime[];
#define  CLOSE_COOLDOWN_SEC 10

//+------------------------------------------------------------------+
void ComputeLicenseMask() {
    if(LicenseKey == "PASTE_YOUR_9_DIGIT_DET_ID_HERE" || LicenseKey == "") {
        g_subLicMask = "NOT SET";
        return;
    }
    int n = StringLen(LicenseKey);
    if(n <= 3) { g_subLicMask = LicenseKey; return; }
    string stars = "";
    for(int i = 0; i < n - 3; i++) stars += "*";
    g_subLicMask = stars + StringSubstr(LicenseKey, n - 3);
}

//+------------------------------------------------------------------+
bool WasRecentlyCloseAttempted(ulong ticket) {
    for(int i = 0; i < ArraySize(g_closeAttemptTk); i++) {
        if(g_closeAttemptTk[i] == ticket) {
            if(TimeCurrent() - g_closeAttemptTime[i] < CLOSE_COOLDOWN_SEC) return true;
            return false;
        }
    }
    return false;
}

void MarkCloseAttempt(ulong ticket) {
    for(int i = 0; i < ArraySize(g_closeAttemptTk); i++) {
        if(g_closeAttemptTk[i] == ticket) {
            g_closeAttemptTime[i] = TimeCurrent();
            return;
        }
    }
    int n = ArraySize(g_closeAttemptTk);
    ArrayResize(g_closeAttemptTk, n + 1);
    ArrayResize(g_closeAttemptTime, n + 1);
    g_closeAttemptTk[n]   = ticket;
    g_closeAttemptTime[n] = TimeCurrent();
}

//+------------------------------------------------------------------+
bool SafeClosePosition(ulong ticket) {
    if(WasRecentlyCloseAttempted(ticket)) return false;   // skip — we just tried
    MarkCloseAttempt(ticket);
    trade.SetExpertMagicNumber(9999);
    bool ok = trade.PositionClose(ticket);
    if(!ok) {
        int err = GetLastError();
        if(err == 4756 || err == 10036 || err == 10039) {
            // Position already closing / already closed — that's fine
            return true;
        }
        Print("[CLOSE] Position #", ticket, " failed. Error: ", err);
        return false;
    }
    return true;
}

//+------------------------------------------------------------------+
bool SafeBuy(double volume, string comment) {
    for(int attempt = 0; attempt < 3; attempt++) {
        trade.SetExpertMagicNumber(8888);
        if(trade.Buy(volume, _Symbol, 0, 0, 0, comment)) {
            Print("[BUY] OK. Ticket: ", trade.ResultOrder());
            return true;
        }
        int err = GetLastError();
        if(err == 10009) return true;                    // done
        if(err == 10004 || err == 10021 || err == 10020) { // requote / off quotes / price changed
            Sleep(300);
            continue;
        }
        Print("[BUY] Attempt ", attempt + 1, " failed. Error: ", err);
        Sleep(500);
    }
    Print("[BUY] FAILED after 3 attempts.");
    return false;
}

bool SafeSell(double volume, string comment) {
    for(int attempt = 0; attempt < 3; attempt++) {
        trade.SetExpertMagicNumber(8888);
        if(trade.Sell(volume, _Symbol, 0, 0, 0, comment)) {
            Print("[SELL] OK. Ticket: ", trade.ResultOrder());
            return true;
        }
        int err = GetLastError();
        if(err == 10009) return true;
        if(err == 10004 || err == 10021 || err == 10020) {
            Sleep(300);
            continue;
        }
        Print("[SELL] Attempt ", attempt + 1, " failed. Error: ", err);
        Sleep(500);
    }
    Print("[SELL] FAILED after 3 attempts.");
    return false;
}

//+------------------------------------------------------------------+
int OnInit() {
    for(int i = 0; i < 6; i++) g_trendCount[i] = 1;
    g_analyticsPrices[0] = "Awaiting Data";
    g_analyticsPrices[1] = "Awaiting Data";
    g_analyticsPrices[2] = "Awaiting Data";
    g_analyticsPrices[3] = "Awaiting Data";
    g_analyticsPrices[4] = "Awaiting Data";

    // NEW: initialize runtime lot size from the input parameter
    g_lotSize = (ManualLotSize > 0) ? ManualLotSize : 0.1;

    ComputeLicenseMask();

    if(LicenseKey == "PASTE_YOUR_9_DIGIT_DET_ID_HERE" || LicenseKey == "")
        MessageBox("WARNING: License Key Missing!\n\nPlease paste your 9-digit D.E.T License Key in the EA settings.",
                   "License Key Missing", MB_ICONWARNING);

    if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
        MessageBox("WARNING: Algo Trading is DISABLED!\n\nPlease click the 'Algo Trading' button in MT5 so it turns GREEN.",
                   "AutoTrading Disabled", MB_ICONWARNING);

    char data[], result[];
    string headers = "Content-Type: application/json\r\n";
    string testPayload = "{\"licenseKey\":\"TEST\",\"currentBalance\":0,\"currentEquity\":0}";
    StringToCharArray(testPayload, data, 0, WHOLE_ARRAY, CP_UTF8);
    ArrayResize(data, ArraySize(data) - 1);
    string resHeaders;
    ResetLastError();
    int res = WebRequest("POST", SyncURL, headers, 5000, data, result, resHeaders);
    if(res == -1 && GetLastError() == 4014)
        MessageBox("WARNING: URL Not Allowed!\n\nAdd 'https://bot-proj-2-1.onrender.com' to Tools > Options > Expert Advisors > Allow WebRequest.",
                   "URL Not Allowed", MB_ICONWARNING);

    Print(">>> Initializing CornerStore Dashboard (v5.5)...");

    g_prevMouseEvt = ChartGetInteger(0, CHART_EVENT_MOUSE_MOVE);
    if(EnableDrag) ChartSetInteger(0, CHART_EVENT_MOUSE_MOVE, true);

    DrawCornerStoreUI();
    EventSetTimer(SyncIntervalSec > 0 ? SyncIntervalSec : 2);
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
    EventKillTimer();
    ObjectsDeleteAll(0, Prefix);
    if(g_dragging) ChartSetInteger(0, CHART_MOUSE_SCROLL, g_prevScroll != 0);
    ChartSetInteger(0, CHART_EVENT_MOUSE_MOVE, g_prevMouseEvt != 0);
    ChartRedraw();
}

//+------------------------------------------------------------------+
void OnTimer() {
    double currentBalance = AccountInfoDouble(ACCOUNT_BALANCE);
    double currentEquity  = AccountInfoDouble(ACCOUNT_EQUITY);
    RefreshLiveUI();

    long   accNum       = AccountInfoInteger(ACCOUNT_LOGIN);
    string brokerName   = AccountInfoString(ACCOUNT_COMPANY);
    string brokerServer = AccountInfoString(ACCOUNT_SERVER);

    int dashPos = StringFind(brokerName, "-");
    g_brokerShort = (dashPos > 0) ? StringSubstr(brokerName, 0, dashPos) : brokerName;

 // Build the open-positions array for this terminal/symbol
string posArray = "[";
int posCount = 0;
for(int i = PositionsTotal() - 1; i >= 0; i--) {
    ulong tk = PositionGetTicket(i);
    if(tk == 0) continue;
    string sym = PositionGetString(POSITION_SYMBOL);
    if(sym != _Symbol) continue;
    long   ptype = PositionGetInteger(POSITION_TYPE);
    string typeStr = (ptype == POSITION_TYPE_BUY) ? "BUY" : "SELL";
    double vol    = PositionGetDouble(POSITION_VOLUME);
    double openP  = PositionGetDouble(POSITION_PRICE_OPEN);
    double slp    = PositionGetDouble(POSITION_SL);
    double tpp    = PositionGetDouble(POSITION_TP);
    double prof   = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
    string cmt    = PositionGetString(POSITION_COMMENT);
    if(posCount > 0) posArray += ",";
    posArray += StringFormat(
        "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%f,"
        "\"openPrice\":%f,\"sl\":%f,\"tp\":%f,\"profit\":%f,\"comment\":\"%s\"}",
        tk, sym, typeStr, vol, openP, slp, tpp, prof, cmt);
    posCount++;
}
posArray += "]";

string jsonPayload = StringFormat(
    "{\"licenseKey\":\"%s\",\"currentBalance\":%f,\"currentEquity\":%f,\"clientSymbol\":\"%s\",\"accountNumber\":\"%d\",\"brokerName\":\"%s\",\"brokerServer\":\"%s\",\"openPositions\":%s}",
    LicenseKey, currentBalance, currentEquity, _Symbol, accNum, brokerName, brokerServer, posArray);
    
    
    char data[], result[];
    string headers = "Content-Type: application/json\r\n";
    StringToCharArray(jsonPayload, data, 0, WHOLE_ARRAY, CP_UTF8);
    ArrayResize(data, ArraySize(data) - 1);

    string resHeaders;
    ResetLastError();
    int res = WebRequest("POST", SyncURL, headers, 5000, data, result, resHeaders);
    int webErr = GetLastError();

    if (res == 200) {
        OnlineStatus = true;
        UpdateStatusBadge("ONLINE", CLR_GREEN);

        string responseText = CharArrayToString(result);
        string action  = ExtractJSONValue(responseText, "action");
        string reason  = ExtractJSONValue(responseText, "reason");

        string tier       = ExtractJSONValue(responseText, "userTier");
        string daysRem    = ExtractJSONValue(responseText, "daysRemaining");
        string hoursRem   = ExtractJSONValue(responseText, "hoursRemaining");
        string minsRem    = ExtractJSONValue(responseText, "minutesRemaining");
        string accStatus  = ExtractJSONValue(responseText, "accountStatus");
        string entryTip   = ExtractJSONValue(responseText, "entryTip");
        string exitTip    = ExtractJSONValue(responseText, "exitTip");
        string levelBtn   = ExtractJSONValue(responseText, "levelBtnText");
        string subLic     = ExtractJSONValue(responseText, "subLicenseMask");
        string cbCount    = ExtractJSONValue(responseText, "connectedBrokersCount");

        if(tier != "") { g_tierName = tier; UpdateLabel(Prefix+"SubTier", g_tierName + " LEVEL", clrWhite); }
        if(daysRem  != "") g_daysRem  = (int)StringToInteger(daysRem);
        if(hoursRem != "") g_hoursRem = (int)StringToInteger(hoursRem);
        if(minsRem  != "") g_minsRem  = (int)StringToInteger(minsRem);
        if(subLic   != "") g_subLicMask = subLic;
        if(levelBtn != "") {
            g_levelBtnText = levelBtn;
            UpdateButtonState(Prefix+"BtnLevel", g_levelBtnText, CLR_BTN_BLUE, clrWhite);
        }
        if(cbCount  != "") g_connectedBrokers = (int)StringToInteger(cbCount);
        if(entryTip != "") { g_entryTip = entryTip; UpdateLabel(Prefix+"EntryTip", g_entryTip, CLR_GREEN); }
        if(exitTip  != "") { g_exitTip  = exitTip;  UpdateLabel(Prefix+"ExitTip",  g_exitTip,  CLR_GREEN); }

        UpdateLabel(Prefix+"TimerText",
                    IntegerToString(g_daysRem) + "days : " + IntegerToString(g_hoursRem) + "hrs : " + IntegerToString(g_minsRem) + "min",
                    CLR_RED);
        UpdateLabel(Prefix+"SubLic", "Subscription Licence No:  " + g_subLicMask, clrWhite);
        UpdateLabel(Prefix+"I_Cn",   "Connected Brokers: " + IntegerToString(g_connectedBrokers), clrWhite);
        UpdateLabel(Prefix+"I_Lic",  "LICENSE No: " + g_subLicMask, clrWhite);

        string tpStr = ExtractJSONValue(responseText, "totalProfit");
        string cpStr = ExtractJSONValue(responseText, "counterProfits");
        string upStr = ExtractJSONValue(responseText, "unprofitableTotal");
        if(tpStr != "") g_totalProfit       = StringToDouble(tpStr);
        if(cpStr != "") g_counterProfits    = StringToDouble(cpStr);
        if(upStr != "") g_unprofitableTotal = StringToDouble(upStr);

        if(accStatus == "ACTIVE") UpdateLabel(Prefix+"AccStatus", "YES", CLR_GREEN);
        else                      UpdateLabel(Prefix+"AccStatus", "NO",  CLR_RED);

        //============= ACTION: KILL =============
        if (action == "KILL") {
            if (!g_killWasActive) {
                g_killWasActive = true;
                g_licenseValid  = false;
                DisableAutoButton();
                MessageBox("Your D.E.T license is INVALID or EXPIRED.\n\nAUTO trade-copying has been disabled.\n\nPlease log into your D.E.T dashboard to renew your subscription.",
                           "License Invalid", MB_ICONWARNING);
            }
            UpdateLabel(Prefix+"Status", "LICENSE INVALID/EXPIRED", CLR_RED);
            AutoModeActive  = false;
            g_lockWasActive = false;
        }
        //============= ACTION: ZERO_HEDGE =============
        else if (action == "ZERO_HEDGE") {
            UpdateLabel(Prefix+"Status", "ACCOUNT LOCKED - " + reason, CLR_AMBER);
            AutoModeActive = false;

            UpdateButtonState(Prefix+"BtnAuto", "AUTO OFF", CLR_BTN_DISABLED, C'130, 130, 140');

            if (!g_lockWasActive) {
                g_lockWasActive = true;
                string msg = "";
                if (reason == "GAIN_TARGET") {
                    msg = "CONGRATULATIONS!\n\nYou reached the 100% GAIN TARGET.\n\nAll positions will be managed by the D.E.T engine until close.\n\nYour account is now LOCKED — log into your D.E.T dashboard to unlock or upgrade.";
                } else if (reason == "LOSS_LIMIT") {
                    msg = "LOSS LIMIT REACHED\n\nYour aggregate equity across all connected accounts reached zero.\n\nAUTO trade-copying is now disabled.\n\nYou can TOP UP within your active subscription to resume trading — same license, same subscription, no new payment required.";
                } else {
                    msg = "ACCOUNT LOCKED\n\nReason: " + reason + "\n\nPlease log into your D.E.T dashboard for details.";
                }
                MessageBox(msg, "Account Locked", MB_ICONINFORMATION);
            }
        }
        //============= ACTION: TRADE =============
        else if (action == "TRADE") {
            if (g_lockWasActive) {
                g_lockWasActive = false;
                g_killWasActive = false;
                g_licenseValid  = true;
                EnableAutoButton();
                MessageBox("Welcome back!\n\nYour top-up was detected and your account is unlocked.\n\nYour subscription is still active — click AUTO to resume trade copying.",
                           "Account Unlocked", MB_ICONINFORMATION);
            }
            if (!g_licenseValid) {
                g_licenseValid  = true;
                g_killWasActive = false;
                EnableAutoButton();
            }

            g_licenseSeen = true;
            UpdateLabel(Prefix+"Status", "Custodial: $" + DoubleToString(currentBalance, 2), CLR_GREEN);

            string masterState  = ExtractJSONBlock(responseText, "masterState");
            string analyticsObj = ExtractJSONBlock(masterState, "analytics");

            if(analyticsObj != "") {
                string anaKeys[]   = {"A_Scalpa","A_Intra","A_Day","A_Swing","A_Long"};
                string anaFields[] = {"scalpa","intra","day","swing","long"};
                for(int i = 0; i < 5; i++) {
                    string v = ExtractJSONValue(analyticsObj, anaFields[i]);
                    if(v != "" && v != "Awaiting Data...") {
                        // NEW: prefix with colon + ensure a "$" is present
                        string amt = v;
                        if(StringFind(amt, "$") < 0) amt = "$" + amt;
                        g_analyticsPrices[i] = ": Unlocked at " + amt;
                    }
                    UpdateLabel(Prefix+anaKeys[i], g_analyticsPrices[i], CLR_LIGHT_BLUE);
                }
            }

            string sb = ExtractJSONValue(responseText, "startingBalance");
            string tb = ExtractJSONValue(responseText, "targetBalance");
            string pt = ExtractJSONValue(responseText, "profitTarget");
            if(sb != "") g_startBal     = StringToDouble(sb);
            if(tb != "") g_targetBal    = StringToDouble(tb);
            if(pt != "") g_profitTarget = StringToDouble(pt);
            RefreshLiveUI();

            string tradesArrayJson = ExtractJSONBlock(responseText, "trades");
            SyncTrades(tradesArrayJson);
        }
    }
    else {
        OnlineStatus = false;
        UpdateStatusBadge("OFFLINE", CLR_RED_BADGE);
        string why = (res == -1) ? " (err " + IntegerToString(webErr) + ")" : " (HTTP " + IntegerToString(res) + ")";
        UpdateLabel(Prefix+"Status", "OFFLINE" + why, CLR_RED);
    }
    ChartRedraw();
}

//+------------------------------------------------------------------+
void UpdateStatusBadge(string text, color bg) {
    if(ObjectFind(0, Prefix+"StatusBadgeBG") >= 0) {
        ObjectSetInteger(0, Prefix+"StatusBadgeBG", OBJPROP_BGCOLOR, bg);
        ObjectSetInteger(0, Prefix+"StatusBadgeBG", OBJPROP_BORDER_COLOR, bg);
    }
    UpdateLabel(Prefix+"K_Status", text, clrWhite);
}

void DisableAutoButton() {
    if(ObjectFind(0, Prefix+"BtnAuto") >= 0) {
        ObjectSetInteger(0, Prefix+"BtnAuto", OBJPROP_BGCOLOR, CLR_BTN_DISABLED);
        ObjectSetInteger(0, Prefix+"BtnAuto", OBJPROP_COLOR, C'130, 130, 140');
        ObjectSetString(0,  Prefix+"BtnAuto", OBJPROP_TEXT, "AUTO OFF");
    }
}

void EnableAutoButton() {
    string t  = AutoModeActive ? "AUTO ON" : "AUTO OFF";
    color  bg = AutoModeActive ? CLR_BTN_GREEN : CLR_BTN_PURPLE;
    color  tx = AutoModeActive ? CLR_BLACK : clrWhite;
    UpdateButtonState(Prefix+"BtnAuto", t, bg, tx);
}

//+------------------------------------------------------------------+
//| NEW: read + sanitize the manual lot input                        |
//+------------------------------------------------------------------+
void CommitLotEdit() {
    if(ObjectFind(0, Prefix+"LotEdit") < 0) return;

    string txt = ObjectGetString(0, Prefix+"LotEdit", OBJPROP_TEXT);
    StringTrimLeft(txt);
    StringTrimRight(txt);

    double v = StringToDouble(txt);
    if(v <= 0) v = 0.01;

    double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
    double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
    double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

    if(step > 0) v = MathRound(v / step) * step;
    if(minL > 0 && v < minL) v = minL;
    if(maxL > 0 && v > maxL) v = maxL;

    g_lotSize = v;
    ObjectSetString(0, Prefix+"LotEdit", OBJPROP_TEXT, DoubleToString(g_lotSize, 2));
    Print("[LOT] Manual lot size set to ", DoubleToString(g_lotSize, 2));
}

//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam) {
    //--- NEW: catch the lot-size edit commit
    if(id == CHARTEVENT_OBJECT_ENDEDIT) {
        if(sparam == Prefix+"LotEdit") {
            CommitLotEdit();
            ChartRedraw();
        }
        return;
    }

    if(id == CHARTEVENT_OBJECT_CLICK) {
        if(sparam == Prefix+"BtnAuto") {
            if (!g_licenseValid) {
                string msg = g_lockWasActive
                    ? "AUTO is disabled because your ACCOUNT is LOCKED.\n\nTop up within your active subscription to unlock, or log into your D.E.T dashboard."
                    : "AUTO is disabled because your LICENSE is invalid or expired.\n\nPlease log into your D.E.T dashboard to renew.";
                MessageBox(msg, "Cannot Enable AUTO", MB_ICONWARNING);
                ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
                return;
            }
            AutoModeActive = !AutoModeActive;
            string statusTxt = AutoModeActive ? "AUTO ON" : "AUTO OFF";
            color bgCol = AutoModeActive ? CLR_BTN_GREEN : CLR_BTN_PURPLE;
            color txtCol = AutoModeActive ? CLR_BLACK : clrWhite;
            UpdateButtonState(Prefix+"BtnAuto", statusTxt, bgCol, txtCol);
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
        }
        else if(sparam == Prefix+"BtnBuy") {
            // NEW: read the live lot field first (in case edit event was missed)
            CommitLotEdit();
            SafeBuy(g_lotSize, "Manual Buy");
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
        }
        else if(sparam == Prefix+"BtnSell") {
            CommitLotEdit();
            SafeSell(g_lotSize, "Manual Sell");
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
        }
        else if(sparam == Prefix+"BtnSwitch") {
            MessageBox("SWITCH TRADER (LOWER LEVELS)\n\n1. Log into your D.E.T dashboard\n2. Go to 'Pricing Plans'\n3. Choose your new tier\n4. Complete the new subscription\n\nNote: Switching levels requires a new subscription.",
                       "Switch Trader", MB_ICONINFORMATION);
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
        }
        else if(sparam == Prefix+"BtnLevel") {
            Print(">>> LEVEL button clicked (currently ", g_levelBtnText, ").");
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
        }
        else if(sparam == Prefix+"BtnCollapse") {
            g_collapsed = !g_collapsed;
            ObjectSetInteger(0, sparam, OBJPROP_STATE, false);
            ApplyCollapse();
        }
        ChartRedraw();
    }
    else if(id == CHARTEVENT_MOUSE_MOVE) {
        if(!EnableDrag) return;
        int mx = (int)lparam;
        int my = (int)dparam;
        bool left = ((((int)StringToInteger(sparam)) & 1) != 0);

        if(left && !g_prevLeft && !g_dragging) {
            if(mx >= UI_X && mx <= UI_X + g_dragMaxX && my >= UI_Y && my <= UI_Y + g_hdrH) {
                g_dragging = true;
                g_dragDX = mx - UI_X;
                g_dragDY = my - UI_Y;
                g_prevScroll = ChartGetInteger(0, CHART_MOUSE_SCROLL);
                ChartSetInteger(0, CHART_MOUSE_SCROLL, false);
            }
        }
        else if(left && g_dragging) {
            MovePanelTo(mx - g_dragDX, my - g_dragDY);
        }

        if(!left && g_dragging) {
            g_dragging = false;
            ChartSetInteger(0, CHART_MOUSE_SCROLL, g_prevScroll != 0);
        }
        g_prevLeft = left;
    }
}

//+------------------------------------------------------------------+
//| Sync trades — now only manages positions on THIS chart's symbol  |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| HARDENED copy-sync:                                          |
//|  * Never closes manual trades (comment must be ALL DIGITS).  |
//|  * Never mass-closes when master payload is empty.            |
//|  * Only closes a copy whose master ticket was previously seen |
//|    and has now disappeared from the master feed.              |
//+------------------------------------------------------------------+
bool IsAllDigits(string s) {
    if(StringLen(s) == 0) return false;
    for(int i = 0; i < StringLen(s); i++) {
        ushort c = StringGetCharacter(s, i);
        if(c < '0' || c > '9') return false;
    }
    return true;
}

bool SeenMasterTicket(ulong ticket) {
    for(int i = 0; i < ArraySize(g_seenMasterTickets); i++)
        if(g_seenMasterTickets[i] == ticket) return true;
    return false;
}

void RememberMasterTicket(ulong ticket) {
    if(SeenMasterTicket(ticket)) return;
    int n = ArraySize(g_seenMasterTickets);
    ArrayResize(g_seenMasterTickets, n + 1);
    g_seenMasterTickets[n] = ticket;
}

void SyncTrades(string tradesJson) {
    bool isEmpty = (tradesJson == "" || tradesJson == "[]");

    if(isEmpty) {
        g_consecutiveEmptyPolls++;
        // Transient empty (1-2 polls) — could be a server hiccup.
        // Don't touch anything yet.
        if(g_consecutiveEmptyPolls < SAFE_EMPTY_THRESHOLD) return;
        // Sustained empty (3+ polls) → master really has 0 trades → proceed.
    } else {
        g_consecutiveEmptyPolls = 0;
    }

    ulong masterTickets[];
    ArrayResize(masterTickets, 0);

    // ── Parse & process master trades (only when non-empty) ──────────
    if(!isEmpty) {
        string tempJson = tradesJson;
        int objStart = StringFind(tempJson, "{");
        while(objStart >= 0) {
            int objEnd = StringFind(tempJson, "}", objStart);
            if(objEnd < 0) break;

            string singleTrade = StringSubstr(tempJson, objStart, objEnd - objStart + 1);

            ulong  m_ticket = (ulong)StringToInteger(ExtractJSONValue(singleTrade, "ticket"));
            string m_symbol = ExtractJSONValue(singleTrade, "symbol");
            string m_type   = ExtractJSONValue(singleTrade, "type");
            double m_vol    = StringToDouble(ExtractJSONValue(singleTrade, "volume"));
            double m_sl     = StringToDouble(ExtractJSONValue(singleTrade, "sl"));
            double m_tp     = StringToDouble(ExtractJSONValue(singleTrade, "tp"));

            if(m_symbol == _Symbol) {
                int n = ArraySize(masterTickets);
                ArrayResize(masterTickets, n + 1);
                masterTickets[n] = m_ticket;
                RememberMasterTicket(m_ticket);

                bool tradeExists = false;
                for(int i = PositionsTotal() - 1; i >= 0; i--) {
                    ulong localTicket = PositionGetTicket(i);
                    if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
                    if(PositionGetString(POSITION_COMMENT) == IntegerToString(m_ticket)) {
                        tradeExists = true;
                        double localSL = PositionGetDouble(POSITION_SL);
                        double localTP = PositionGetDouble(POSITION_TP);
                        if((localSL != m_sl || localTP != m_tp) && AutoModeActive)
                            trade.PositionModify(localTicket, m_sl, m_tp);
                        break;
                    }
                }

                if(!tradeExists && AutoModeActive) {
                    trade.SetExpertMagicNumber(9999);
                    if(m_type == "BUY")
                        trade.Buy(m_vol, m_symbol, 0, m_sl, m_tp, IntegerToString(m_ticket));
                    else if(m_type == "SELL")
                        trade.Sell(m_vol, m_symbol, 0, m_sl, m_tp, IntegerToString(m_ticket));
                }
            }

            tempJson = StringSubstr(tempJson, objEnd + 1);
            objStart = StringFind(tempJson, "{");
        }
    }

    // ── Close copies whose master ticket is gone ─────────────────────
    //   * Manual trades: NEVER touched (comment must be pure digits)
    //   * Only tickets we've previously seen can be closed
    //   * Runs even on empty payload (after grace period)
    if(!AutoModeActive) return;
    for(int i = PositionsTotal() - 1; i >= 0; i--) {
        ulong localTicket = PositionGetTicket(i);
        if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
        string localComment = PositionGetString(POSITION_COMMENT);
        if(!IsAllDigits(localComment)) continue;
        ulong mTicket = (ulong)StringToInteger(localComment);
        bool inMaster = false;
        for(int j = 0; j < ArraySize(masterTickets); j++)
            if(masterTickets[j] == mTicket) { inMaster = true; break; }
        bool wasSeen = SeenMasterTicket(mTicket);
        if(!inMaster && wasSeen) SafeClosePosition(localTicket);
    }
}

// Deprecated — kept only so old references compile.
void CloseAllCopiedTrades() {
    // Intentionally a no-op: emptied master feed must never mass-close.
}

void ForceCloseAllCopied() {
    if(!AutoModeActive) return;
    for(int i = PositionsTotal() - 1; i >= 0; i--) {
        ulong tk = PositionGetTicket(i);
        if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
        string c = PositionGetString(POSITION_COMMENT);
        if(IsAllDigits(c)) SafeClosePosition(tk);
    }
}
//+------------------------------------------------------------------+
string ExtractJSONValue(string json, string key) {
    int keyPos = StringFind(json, "\"" + key + "\":");
    if(keyPos < 0) return "";
    int valStart = keyPos + StringLen(key) + 3;
    bool isString = (StringGetCharacter(json, valStart) == '"');
    if(isString) valStart++;
    int valEnd = -1;
    if(isString) { valEnd = StringFind(json, "\"", valStart); }
    else {
        int commaPos = StringFind(json, ",", valStart);
        int bracePos = StringFind(json, "}", valStart);
        if(commaPos > 0 && bracePos > 0) valEnd = (int)MathMin(commaPos, bracePos);
        else if(commaPos > 0) valEnd = commaPos;
        else valEnd = bracePos;
    }
    if(valEnd > valStart) return StringSubstr(json, valStart, valEnd - valStart);
    return "";
}

string ExtractJSONBlock(string json, string key) {
    int keyPos = StringFind(json, "\"" + key + "\":");
    if(keyPos < 0) return "";
    int len = StringLen(json);
    int start = keyPos + StringLen(key) + 3;
    while(start < len && StringGetCharacter(json, start) == ' ') start++;
    if(start >= len) return "";

    ushort openCh = StringGetCharacter(json, start);
    ushort closeCh = 0;
    if(openCh == '{') closeCh = '}';
    else if(openCh == '[') closeCh = ']';
    else return ExtractJSONValue(json, key);

    int depth = 0;
    bool inStr = false;
    for(int i = start; i < len; i++) {
        ushort c = StringGetCharacter(json, i);
        if(inStr) { if(c == '\\') i++; else if(c == '"') inStr = false; continue; }
        if(c == '"') inStr = true;
        else if(c == openCh) depth++;
        else if(c == closeCh) { depth--; if(depth == 0) return StringSubstr(json, start, i - start + 1); }
    }
    return "";
}

//+------------------------------------------------------------------+
int TextW(string text, int size, bool bold) {
    TextSetFont(g_font, -size * 10, bold ? 700 : 400, 0);
    uint w = 0, h = 0;
    if(!TextGetSize(text, w, h)) return StringLen(text) * (size + 1);
    return (int)w + 2;
}

int FitFont(string text, int maxW, int size, int minSize, bool bold) {
    while(size > minSize && TextW(text, size, bold) > maxW) size--;
    return size;
}

string FmtNum(double v) {
    string s = DoubleToString(MathAbs(v), 2);
    int dot = StringFind(s, ".");
    string ip = (dot >= 0) ? StringSubstr(s, 0, dot) : s;
    string fp = (dot >= 0) ? StringSubstr(s, dot) : "";
    string outStr = "";
    int n = StringLen(ip);
    for(int i = 0; i < n; i++) {
        outStr += StringSubstr(ip, i, 1);
        int rem = n - 1 - i;
        if(rem > 0 && rem % 3 == 0) outStr += ",";
    }
    return ((v < 0) ? "-" : "") + outStr + fp;
}

//+------------------------------------------------------------------+
void RegObj(string name) {
    int n = ArraySize(g_objs);
    ArrayResize(g_objs, n + 1); ArrayResize(g_objGrp, n + 1);
    g_objs[n] = name; g_objGrp[n] = g_curGrp;
}

void CacheLabel(string name, string text, color clr) {
    int n = ArraySize(g_cName);
    for(int i = 0; i < n; i++) if(g_cName[i] == name) { g_cText[i] = text; g_cClr[i] = clr; return; }
    ArrayResize(g_cName, n + 1); ArrayResize(g_cText, n + 1); ArrayResize(g_cClr, n + 1);
    g_cName[n] = name; g_cText[n] = text; g_cClr[n] = clr;
}

void RestoreCache() {
    for(int i = 0; i < ArraySize(g_cName); i++) UpdateLabel(g_cName[i], g_cText[i], g_cClr[i]);
}

void SetTip(string name, string tip) {
    if(ObjectFind(0, name) >= 0) ObjectSetString(0, name, OBJPROP_TOOLTIP, tip);
}

void FitLabel(string name, string text) {
    int maxW = 0, base = 9; bool bold = false;
    string anaKeys[]   = {"A_Scalpa","A_Intra","A_Day","A_Swing","A_Long"};
    string trendKeys[] = {"V_Long","V_Swing","V_Day","V_Intra","V_Scalpa","V_Real"};

    if(name == Prefix+"K_Status")               { maxW = g_statusBadgeMaxW; base = 11; bold = true; }
    else if(StringFind(name, Prefix+"K_") == 0) { maxW = g_wTile; base = 14; bold = true; }
    else if(name == Prefix+"EntryTip" || name == Prefix+"ExitTip") { maxW = 240; base = 10; }
    else if(name == Prefix+"I_Acc" || name == Prefix+"I_Brk" || name == Prefix+"I_Lic" || name == Prefix+"I_Cn" || name == Prefix+"I_Time")
        { maxW = g_infoItemW5; base = 9; bold = true; }
    else if(name == Prefix+"StartVal") { maxW = g_startValMaxW; base = 13; bold = true; }
    else if(name == Prefix+"F2")       { maxW = g_gainValMaxW;  base = 12; bold = true; }
    else if(name == Prefix+"SubTier")  { maxW = g_subTierMaxW;  base = 12; bold = true; }
    else if(name == Prefix+"SubLic")   { maxW = g_subLicMaxW;   base = 9;  bold = false; }
    else {
        for(int i = 0; i < 5; i++)
            if(name == Prefix+anaKeys[i]) { maxW = g_analyticsMaxW[i]; base = 10; }
        for(int i = 0; i < 6; i++)
            if(name == Prefix+trendKeys[i]) { maxW = g_trendMaxW[i]; base = 10; }
    }
    if(maxW <= 0) return;
    ObjectSetInteger(0, name, OBJPROP_FONTSIZE, FitFont(text, maxW, base, 6, bold));
}

void UpdateLabel(string name, string text, color clr) {
    if(ObjectFind(0, name) >= 0) {
        ObjectSetString(0,  name, OBJPROP_TEXT, text);
        ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
        FitLabel(name, text);
        CacheLabel(name, text, clr);
    }
}

void UpdateButtonState(string name, string text, color bg, color txt) {
    if(ObjectFind(0, name) >= 0) {
        ObjectSetString(0,  name, OBJPROP_TEXT, text);
        ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bg);
        ObjectSetInteger(0, name, OBJPROP_COLOR, txt);
        ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, (bg == CLR_BLACK) ? txt : bg);
        int bw = (int)ObjectGetInteger(0, name, OBJPROP_XSIZE);
        if(bw > 0) ObjectSetInteger(0, name, OBJPROP_FONTSIZE, FitFont(text, bw-10, 9, 6, true));
    }
}

void CreatePanel(string name, int x, int y, int w, int h, color bgClr, color borderClr) {
    ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
    ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
    ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
    ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
    ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
    ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bgClr);
    ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, borderClr);
    ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
    ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
    ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
    ObjectSetInteger(0, name, OBJPROP_ZORDER, 0);
    ObjectSetString(0,  name, OBJPROP_TOOLTIP, "");
    RegObj(name);
}

void CreateLabel(string name, string text, int x, int y, color clr, int size, bool bold, ENUM_ANCHOR_POINT anchor) {
    ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
    ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
    ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
    ObjectSetString(0,  name, OBJPROP_TEXT, text);
    ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
    ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size);
    ObjectSetString(0,  name, OBJPROP_FONT, bold ? "Arial Bold" : "Arial");
    ObjectSetInteger(0, name, OBJPROP_ANCHOR, anchor);
    ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
    ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
    ObjectSetInteger(0, name, OBJPROP_ZORDER, 1);
    ObjectSetString(0,  name, OBJPROP_TOOLTIP, "");
    RegObj(name);
}

void CreateLabel(string name, string text, int x, int y, color clr, int size, bool bold) {
    CreateLabel(name, text, x, y, clr, size, bold, ANCHOR_LEFT_UPPER);
}

void CreateLabelFit(string name, string text, int x, int y, color clr, int size, bool bold, int maxW) {
    CreateLabel(name, text, x, y, clr, FitFont(text, maxW, size, 6, bold), bold, ANCHOR_LEFT_UPPER);
}

void CreateLabelFitRight(string name, string text, int rightX, int y, color clr, int size, bool bold, int maxW) {
    CreateLabel(name, text, rightX, y, clr, FitFont(text, maxW, size, 6, bold), bold, ANCHOR_RIGHT_UPPER);
}

void CreateButton(string name, string text, int x, int y, int w, int h, color txtClr, color bgClr) {
    ObjectCreate(0, name, OBJ_BUTTON, 0, 0, 0);
    ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
    ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
    ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
    ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
    ObjectSetString(0,  name, OBJPROP_TEXT, text);
    ObjectSetInteger(0, name, OBJPROP_COLOR, txtClr);
    ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bgClr);
    ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, CLR_BLACK);
    ObjectSetInteger(0, name, OBJPROP_FONTSIZE, FitFont(text, w-10, 9, 6, true));
    ObjectSetString(0,  name, OBJPROP_FONT, "Arial Bold");
    ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
    ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
    ObjectSetInteger(0, name, OBJPROP_ZORDER, 2);
    ObjectSetString(0,  name, OBJPROP_TOOLTIP, "");
    RegObj(name);
}

//+------------------------------------------------------------------+
//| NEW: create an editable text field (for manual lot size)         |
//+------------------------------------------------------------------+
void CreateEdit(string name, string text, int x, int y, int w, int h, color txtClr, color bgClr) {
    ObjectCreate(0, name, OBJ_EDIT, 0, 0, 0);
    ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
    ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
    ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
    ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
    ObjectSetString(0,  name, OBJPROP_TEXT, text);
    ObjectSetInteger(0, name, OBJPROP_COLOR, txtClr);
    ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bgClr);
    ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, CLR_BORDER);
    ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 11);
    ObjectSetString(0,  name, OBJPROP_FONT, "Arial Bold");
    ObjectSetInteger(0, name, OBJPROP_ALIGN, ALIGN_CENTER);
    ObjectSetInteger(0, name, OBJPROP_READONLY, false);
    ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
    ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
    ObjectSetInteger(0, name, OBJPROP_ZORDER, 3);
    ObjectSetString(0,  name, OBJPROP_TOOLTIP, "Enter lot size then press Enter");
    RegObj(name);
}

//+------------------------------------------------------------------+
void MovePanelTo(int nx, int ny) {
    int cw = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
    int ch = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);
    int h  = g_collapsed ? g_collH : g_fullH;
    nx = MathMax(0, MathMin(nx, cw - UI_W));
    ny = MathMax(0, MathMin(ny, ch - h));
    int dx = nx - UI_X, dy = ny - UI_Y;
    if(dx == 0 && dy == 0) return;
    for(int i = 0; i < ArraySize(g_objs); i++) {
        int ox = (int)ObjectGetInteger(0, g_objs[i], OBJPROP_XDISTANCE);
        int oy = (int)ObjectGetInteger(0, g_objs[i], OBJPROP_YDISTANCE);
        ObjectSetInteger(0, g_objs[i], OBJPROP_XDISTANCE, ox + dx);
        ObjectSetInteger(0, g_objs[i], OBJPROP_YDISTANCE, oy + dy);
    }
    UI_X = nx; UI_Y = ny;
    ChartRedraw();
}

void ApplyCollapse() {
    long tf = g_collapsed ? OBJ_NO_PERIODS : OBJ_ALL_PERIODS;
    for(int i = 0; i < ArraySize(g_objs); i++)
        if(g_objGrp[i] == GRP_BODY)
            ObjectSetInteger(0, g_objs[i], OBJPROP_TIMEFRAMES, tf);
    ObjectSetInteger(0, Prefix+"BG", OBJPROP_YSIZE, g_collapsed ? g_collH : g_fullH);
    if(ObjectFind(0, Prefix+"BtnCollapse") >= 0)
        ObjectSetString(0, Prefix+"BtnCollapse", OBJPROP_TEXT,
                        ShortToString(g_collapsed ? 0x25BC : 0x25B2));
    ChartRedraw();
}

void SyncAutoButtonVisual() {
    if (!g_licenseValid) { DisableAutoButton(); return; }
    string t  = AutoModeActive ? "AUTO ON" : "AUTO OFF";
    color  bg = AutoModeActive ? CLR_BTN_GREEN : CLR_BTN_PURPLE;
    color  tx = AutoModeActive ? CLR_BLACK : clrWhite;
    UpdateButtonState(Prefix+"BtnAuto", t, bg, tx);
}

//+------------------------------------------------------------------+
void RefreshLiveUI() {
    double bal = AccountInfoDouble(ACCOUNT_BALANCE);
    double eq  = AccountInfoDouble(ACCOUNT_EQUITY);

    double profits = 0, losses = 0;
    for(int i = PositionsTotal() - 1; i >= 0; i--) {
        ulong tk = PositionGetTicket(i);
        if(tk == 0) continue;
        if(PositionGetString(POSITION_COMMENT) == "") continue;
        double p = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
        if(p < 0) losses += p; else profits += p;
    }

    UpdateLabel(Prefix+"K_Bal", "$" + FmtNum(bal), CLR_GREEN);

    double tp = profits + losses;
    color tpClr = (tp >= 0) ? CLR_GREEN : CLR_RED;
    UpdateLabel(Prefix+"K_TotalProfit",
                (tp >= 0 ? "" : "-") + "$" + FmtNum(MathAbs(tp)), tpClr);

    color cpClr = (profits >= 0) ? CLR_GREEN : CLR_RED;
    UpdateLabel(Prefix+"K_CounterProfit",
                (profits >= 0 ? "+" : "") + "$" + FmtNum(MathAbs(profits)), cpClr);

    UpdateLabel(Prefix+"K_Unprofitable",
                "-$" + FmtNum(MathAbs(losses)), CLR_RED);

   UpdateLabel(Prefix+"StartVal", "$" + FmtNum(g_startBal),  CLR_GREEN);
   UpdateLabel(Prefix+"F2",       "$" + FmtNum(g_targetBal), CLR_GREEN);
   UpdateLabel(Prefix+"ProfitTargetVal", "+$" + FmtNum(g_profitTarget), CLR_GREEN);

    double pct = 0;
    if(g_startBal > 0 && g_targetBal > g_startBal)
        pct = (eq - g_startBal) / (g_targetBal - g_startBal);
    pct = MathMax(0.0, MathMin(1.0, pct));

    UpdateLabel(Prefix+"ProgTxt", DoubleToString(pct * 100.0, 1) + "%", CLR_GREEN);
    UpdateLabel(Prefix+"ProgPct", DoubleToString(pct * 100.0, 1) + "% / 100%", CLR_MUTED);

    if(ObjectFind(0, Prefix+"ProgFill") >= 0) {
        int fw = (int)MathMax(2.0, (g_progW - 2) * pct);
        ObjectSetInteger(0, Prefix+"ProgFill", OBJPROP_XSIZE, fw);
    }

    // Live clock
    UpdateLabel(Prefix+"I_Time",
                "TIME: " + TimeToString(TimeLocal(), TIME_SECONDS),
                clrWhite);
}

//+------------------------------------------------------------------+
//|                    MAIN UI DRAW FUNCTION                         |
//+------------------------------------------------------------------+
void DrawCornerStoreUI() {
    ObjectsDeleteAll(0, Prefix);
    ArrayResize(g_objs, 0);
    ArrayResize(g_objGrp, 0);

    UI_W = (PanelWidth > 0) ? PanelWidth : 780;

    int pad = g_pad;
    int W   = UI_W;
    int y   = UI_Y;

    // 1. Background
    g_curGrp = GRP_HDR;
    CreatePanel(Prefix+"BG", UI_X, UI_Y, W, 100, CLR_BG, CLR_BORDER);

    // 2. Header
    CreateLabel(Prefix+"Title", "CornerStore", UI_X+pad, y+12, CLR_GOLD, 15, true);
    int titleW = TextW("CornerStore", 15, true);

    int collW = 26;
    int collH = 24;
    int collX = UI_X + W - pad - collW;
    int collY = y + 10;
    CreateButton(Prefix+"BtnCollapse", ShortToString(0x25B2), collX, collY, collW, collH, clrWhite, CLR_CARD);
    SetTip(Prefix+"BtnCollapse", "Collapse / expand panel");

    int badgeW = 90;
    int badgeH = 24;
    int badgeX = collX - badgeW - 8;
    int badgeY = y + 10;

    CreatePanel(Prefix+"StatusBadgeBG", badgeX, badgeY, badgeW, badgeH, CLR_RED_BADGE, CLR_RED_BADGE);
    g_statusBadgeMaxW = badgeW - 22 - 6;
    CreateLabelFit(Prefix+"K_Status", "OFFLINE", badgeX+22, badgeY+4, clrWhite, 11, true, g_statusBadgeMaxW);
    SetTip(Prefix+"K_Status", "Connection status to D.E.T server");

    int subX    = UI_X+pad+titleW+12;
    int subMaxW = (badgeX - 8) - subX;
    CreateLabelFit(Prefix+"Subtitle", "1:5 Human-Trader Ratio", subX, y+15, clrWhite, 12, false, subMaxW);

    y += g_hdrH + 6;

    // 3. KPI Row
    g_curGrp = GRP_BODY;

    string kpiCaps[] = {"BALANCE", "TOTAL PROFIT $", "COUNTER PROFITS", "Unprofitables"};
    string kpiKeys[] = {"K_Bal", "K_TotalProfit", "K_CounterProfit", "K_Unprofitable"};

    int kpiGap = 6;
    int kpiW   = (W - 2*pad - 3*kpiGap) / 4;
    int kpiH   = 68;

    g_wTile = kpiW - 16;

    for(int i = 0; i < 4; i++) {
        int kx = UI_X + pad + i*(kpiW + kpiGap);
        CreatePanel(Prefix+"KT"+IntegerToString(i), kx, y, kpiW, kpiH, CLR_CARD, CLR_BORDER);
        CreateLabelFit(Prefix+"KC"+IntegerToString(i), kpiCaps[i], kx+8, y+10, clrWhite, 9, true, kpiW-16);
        CreateLabelFit(Prefix+kpiKeys[i], "$0.00", kx+8, y+34, CLR_GREEN, 14, true, kpiW-16);
    }
    y += kpiH + 6;

    // 4. Trends + Analytics
    int colGap = 6;
    int wLeft  = (int)((W - 2*pad - colGap) * 0.52);
    int wRight = W - 2*pad - colGap - wLeft;
    int xLeft  = UI_X + pad;
    int xRight = xLeft + wLeft + colGap;

    int cardY   = y;
    int cardH   = 215;
    int secHdrH = 34;

    CreatePanel(Prefix+"TrendsBox", xLeft, cardY, wLeft, cardH, CLR_CARD, CLR_BORDER);
    CreateLabel(Prefix+"TrendsTitle", _Symbol + " TREND", xLeft+10, cardY+10, clrWhite, 11, true);
    CreatePanel(Prefix+"TrendsDiv", xLeft+4, cardY+secHdrH, wLeft-8, 1, CLR_BORDER, CLR_BORDER);

    string trendNames[] = {"LongTrader", "SwingTrader", "DayTrader", "IntraTrader", "ScalpaTrader", "Realtime"};
    string trendKeys[]  = {"V_Long", "V_Swing", "V_Day", "V_Intra", "V_Scalpa", "V_Real"};

    int rowY0 = cardY + secHdrH + 6;
    int rowH  = 26;

    for(int i = 0; i < 6; i++) {
        int ry = rowY0 + i*rowH;
        CreateLabel(Prefix+"TN"+IntegerToString(i), trendNames[i], xLeft+10, ry, clrWhite, 10, false);

        int badgeBoxX = xLeft + (int)(wLeft * 0.38);
        CreatePanel(Prefix+"TB"+IntegerToString(i), badgeBoxX, ry+1, 18, 17, CLR_CYAN_BADGE, CLR_CYAN_BADGE);
        CreateLabel(Prefix+"TBN"+IntegerToString(i), IntegerToString(g_trendCount[i]),
                    badgeBoxX+5, ry+2, CLR_BLACK, 10, true);

        g_trendMaxW[i] = (xLeft + wLeft - 10) - (badgeBoxX + 18 + 8);
        CreateLabelFitRight(Prefix+trendKeys[i], "Awaiting Data",
                    xLeft + wLeft - 10, ry, CLR_LIGHT_BLUE, 10, false, g_trendMaxW[i]);
    }

    CreatePanel(Prefix+"AnalyticsBox", xRight, cardY, wRight, cardH, CLR_CARD, CLR_BORDER);
    CreateLabel(Prefix+"AnalyticsTitle", "MARKET ANALYTICS", xRight+10, cardY+10, clrWhite, 11, true);
    CreatePanel(Prefix+"AnalyticsDiv", xRight+4, cardY+secHdrH, wRight-8, 1, CLR_BORDER, CLR_BORDER);

    string analyticsNames[] = {"ScalpaTrader", "IntraTrader", "DayTrader", "SwingTrader", "LongTrader"};
    string analyticsKeys[]  = {"A_Scalpa", "A_Intra", "A_Day", "A_Swing", "A_Long"};

    int aRowY0 = cardY + secHdrH + 10;
    int aRowH  = 32;

    for(int i = 0; i < 5; i++) {
        int ry = aRowY0 + i*aRowH;
        CreateLabel(Prefix+"AN"+IntegerToString(i), analyticsNames[i], xRight+10, ry, clrWhite, 10, true);
        int anLabelW = TextW(analyticsNames[i], 10, true);
        g_analyticsMaxW[i] = wRight - 20 - anLabelW - 10;
        CreateLabelFitRight(Prefix+analyticsKeys[i], g_analyticsPrices[i],
                    xRight + wRight - 10, ry, CLR_LIGHT_BLUE, 10, false, g_analyticsMaxW[i]);
    }

    y = cardY + cardH + 6;

    // 5. Performance + Subscription
    int perfY = y;
    int perfH = 190;

    CreatePanel(Prefix+"PerfBox", xLeft, perfY, wLeft, perfH, CLR_CARD, CLR_BORDER);

    CreateLabel(Prefix+"StartLabel", "Starting Balance", xLeft+10, perfY+14, clrWhite, 10, true);
    g_startValMaxW = wLeft - 20 - TextW("Starting Balance", 10, true) - 10;
    CreateLabelFitRight(Prefix+"StartVal", "$0.00",
                xLeft+wLeft-10, perfY+14, CLR_GREEN, 13, true, g_startValMaxW);

    CreateLabel(Prefix+"ProgLabel", "Progress to 100% Gain:", xLeft+10, perfY+46, clrWhite, 10, true);
    CreateLabel(Prefix+"ProgTxt", "0.0%",
                xLeft+wLeft-10, perfY+46, CLR_GREEN, 11, true, ANCHOR_RIGHT_UPPER);

    g_progW = wLeft - 24;
    CreatePanel(Prefix+"ProgBG", xLeft+12, perfY+72, g_progW, 14, CLR_CARD2, CLR_LINE);
    CreatePanel(Prefix+"ProgFill", xLeft+13, perfY+73, 2, 12, CLR_GREEN, CLR_GREEN);
    CreateLabel(Prefix+"ProgPct", "0.0% / 100%",
                xLeft+wLeft-12, perfY+90, CLR_MUTED, 8, false, ANCHOR_RIGHT_UPPER);

    CreateLabel(Prefix+"EntryTipL", "ENTRY TIPS:", xLeft+10, perfY+118, CLR_GREEN, 10, true);
    CreateLabel(Prefix+"EntryTip",  g_entryTip, xLeft+110, perfY+118, CLR_GREEN, 10, false);

    CreateLabel(Prefix+"ExitTipL", "EXIT TIPS   :", xLeft+10, perfY+150, CLR_GREEN, 10, true);
    CreateLabel(Prefix+"ExitTip",  g_exitTip, xLeft+110, perfY+150, CLR_GREEN, 10, false);

    CreatePanel(Prefix+"SubBox", xRight, perfY, wRight, perfH, CLR_CARD, CLR_BORDER);

    CreatePanel(Prefix+"TierBG", xRight+3, perfY+3, wRight-6, 30, CLR_PURPLE, CLR_PURPLE2);
    g_subTierMaxW = wRight - 16;
    CreateLabel(Prefix+"SubTier", g_tierName + " LEVEL", xRight + wRight/2, perfY+9, clrWhite,
                FitFont(g_tierName + " LEVEL", g_subTierMaxW, 12, 8, true), true, ANCHOR_UPPER);

    g_subLicMaxW = wRight - 20;
    CreateLabelFit(Prefix+"SubLic", "Subscription Licence No:  " + g_subLicMask,
                xRight+10, perfY+46, clrWhite, 9, false, g_subLicMaxW);

    CreateLabel(Prefix+"TimerIcon", "*", xRight+10, perfY+70, CLR_RED_BADGE, 18, true);
    CreateLabel(Prefix+"TimerText",
                IntegerToString(g_daysRem) + "days : " +
                IntegerToString(g_hoursRem) + "hrs : " +
                IntegerToString(g_minsRem) + "min",
                xRight+28, perfY+75, CLR_RED, 11, true);

   // --- Tier-based auto-logout line -----------------------------------
   CreateLabel(Prefix+"GainLbl", "Auto-Logout At (Tier Target):", xRight+10, perfY+112, clrWhite, 10, true);
   g_gainValMaxW = wRight - 20 - TextW("Auto-Logout At (Tier Target):", 10, true) - 10;
   CreateLabelFitRight(Prefix+"F2", "$0.00",
               xRight+wRight-10, perfY+112, CLR_GREEN, 12, true, g_gainValMaxW);
   
   // Profit-target line (new) — small, below the logout balance
   CreateLabel(Prefix+"ProfitTargetLbl", "Tier Profit Target:", xRight+10, perfY+130, CLR_GREEN, 9, true);
   CreateLabelFitRight(Prefix+"ProfitTargetVal", "+$0.00",
               xRight+wRight-10, perfY+130, CLR_GREEN, 11, true, wRight-20 - TextW("Tier Profit Target:", 9, true) - 10);
   
   CreateLabelFit(Prefix+"SubNote",
                  "Auto-logout when tier profit target is reached. Target is based on your subscription tier, not your deposit (Caveat Subscriptor T&C APPLY)",
                  xRight+10, perfY+150, CLR_MUTED, 7, false, wRight-20);

    y = perfY + perfH + 6;

    // ==========================================================
    // 5.5 NEW: Manual Lot Size Row (edit field for BUY / SELL)
    // ==========================================================
    int lotRowH = 40;
    CreatePanel(Prefix+"LotRow", UI_X+pad, y, W-2*pad, lotRowH, CLR_CARD, CLR_BORDER);

    CreateLabel(Prefix+"LotLbl", "MANUAL LOT SIZE", UI_X+pad+14, y+12, clrWhite, 10, true);
    CreateLabelFit(Prefix+"LotHint", "(for BUY / SELL)  —  press Enter to apply",
                   UI_X+pad+14 + TextW("MANUAL LOT SIZE", 10, true) + 12,
                   y+13, CLR_MUTED, 8, false, (W-2*pad) - 200);

    int editW = 130;
    int editH = 26;
    int editX = UI_X + W - pad - 14 - editW;
    int editY = y + (lotRowH - editH) / 2;
    CreateEdit(Prefix+"LotEdit", DoubleToString(g_lotSize, 2),
               editX, editY, editW, editH, CLR_GREEN, CLR_CARD2);
    SetTip(Prefix+"LotEdit", "Type the lot size then press Enter. Used for manual BUY / SELL.");

    y += lotRowH + 6;

    // 6. Button Row
    string bTxt[5];
    string bNm[5];
    color  bBg[5];
    color  bTx[5];

    bNm[0] = "BtnSwitch";  bTxt[0] = "SWITCH TRADER";       bBg[0] = CLR_BTN_BLUE;   bTx[0] = clrWhite;
    bNm[1] = "BtnLevel";   bTxt[1] = g_levelBtnText;        bBg[1] = CLR_BTN_BLUE;   bTx[1] = clrWhite;
    bNm[2] = "BtnBuy";     bTxt[2] = "BUY ORDER";           bBg[2] = CLR_BTN_GREEN;  bTx[2] = CLR_BLACK;
    bNm[3] = "BtnAuto";    bTxt[3] = "AUTO OFF";            bBg[3] = CLR_BTN_PURPLE; bTx[3] = clrWhite;
    bNm[4] = "BtnSell";    bTxt[4] = "SELL ORDER";          bBg[4] = CLR_BTN_RED;    bTx[4] = clrWhite;

    int bGap = 5;
    int bW   = (W - 2*pad - 4*bGap) / 5;
    int bH   = 36;

    int bx = UI_X + pad;
    for(int i = 0; i < 5; i++) {
        CreateButton(Prefix+bNm[i], bTxt[i], bx, y, bW, bH, bTx[i], bBg[i]);
        bx += bW + bGap;
    }
    SetTip(Prefix+"BtnSwitch", "Switch to a lower-level trader");
    SetTip(Prefix+"BtnLevel",  "Your current trader level (read-only)");
    SetTip(Prefix+"BtnBuy",    "Manual BUY order with the manual lot size");
    SetTip(Prefix+"BtnAuto",   "Auto-copy ON/OFF");
    SetTip(Prefix+"BtnSell",   "Manual SELL order with the manual lot size");

    y += bH + 6;

    // 7. Compliance
    int compH = 66;
    CreatePanel(Prefix+"CompBox", UI_X+pad, y, W-2*pad, compH, CLR_CARD, CLR_BORDER);

    CreateLabelFit(Prefix+"C1",
                   "D.E.T NOT an Advisory Institution. NOT an Investment Institution. NOT an Investment Adviser,",
                   UI_X+pad+12, y+12, clrWhite, 8, true, W-2*pad-24);

    CreateLabelFit(Prefix+"C2",
                   "Caveat Subscriptor: \"NO Guarantees\", You may ACTUALLY lose all your capital, (T&C Apply)",
                   UI_X+pad+12, y+36, CLR_MUTED, 8, false, W-2*pad-24);

    y += compH + 6;

    // 8. Bottom Info Bar - 5 columns
    int infoH = 38;
    CreatePanel(Prefix+"InfoBar", UI_X+pad, y, W-2*pad, infoH, CLR_CARD, CLR_BORDER);

    string accStr = "ACCOUNT #" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
    string brkStr = g_brokerShort + " Option";
    string licStr = "LICENSE No: " + g_subLicMask;
    string cnStr  = "Connected Brokers: " + IntegerToString(g_connectedBrokers);
    string tmStr  = "TIME: " + TimeToString(TimeLocal(), TIME_SECONDS);

    int itemW = (W - 2*pad) / 5;
    int labelY = y + 13;

    g_infoItemW5 = itemW - 14;

    CreateLabelFit(Prefix+"I_Acc",  accStr, UI_X+pad+8,          labelY, clrWhite, 9, true, g_infoItemW5);
    CreateLabelFit(Prefix+"I_Brk",  brkStr, UI_X+pad+itemW+8,    labelY, clrWhite, 9, true, g_infoItemW5);
    CreateLabelFit(Prefix+"I_Lic",  licStr, UI_X+pad+2*itemW+8,  labelY, clrWhite, 9, true, g_infoItemW5);
    CreateLabelFit(Prefix+"I_Cn",   cnStr,  UI_X+pad+3*itemW+8,  labelY, clrWhite, 9, true, g_infoItemW5);
    CreateLabelFit(Prefix+"I_Time", tmStr,  UI_X+pad+4*itemW+8,  labelY, clrWhite, 9, true, g_infoItemW5);

    for(int i = 1; i < 5; i++) {
        CreatePanel(Prefix+"InfoDiv"+IntegerToString(i),
                    UI_X+pad+i*itemW, y+7, 1, infoH-14, CLR_LINE, CLR_LINE);
    }

    y += infoH + 6;

    // 9. Finalize
    g_fullH = y - UI_Y;
    g_collH = g_hdrH + 6;

    SyncAutoButtonVisual();
    RestoreCache();
    RefreshLiveUI();
    UpdateStatusBadge(OnlineStatus ? "ONLINE" : "OFFLINE",
                      OnlineStatus ? CLR_GREEN : CLR_RED_BADGE);
    ApplyCollapse();
    ChartRedraw();
}
//+------------------------------------------------------------------+