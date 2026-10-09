/* ──────────────────────────────────────────────────────────────────────────
   App language system (Chinese first).

   window.PortalI18N:
     t(key)              → dictionary string (English fallback, then key)
     translateError(s)   → maps known server error sentences to the language
     setLang(code)       → switch + persist (localStorage "portal-lang") + apply
     applyTranslations() → data-i18n attributes + (mode2/makevideo) text sweep

   Pages:
     portal.html   — uses data-i18n attributes on marked elements.
     mode2/makevideo — <body data-i18n-sweep>: a TreeWalker translates every
       text node found in PHRASES, and a MutationObserver keeps translating
       dynamically toggled states ("Mic: On" → "麦克风：开") and injected UI.
       Switching back to English restores each node's captured original.

   First visit picks the browser language (zh* → Chinese, else English);
   the visitor's explicit choice is remembered and shared by every page
   (same-origin localStorage).
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  const STORE_KEY = "portal-lang";

  /* Exact-match dictionary for [data-i18n] elements (portal) and error maps. */
  const DICTS = {
    zh: {
      docTitle: "TikTokkingDubai 登录",
      secureAccess: "安全登录",
      loginSubtitle: "输入您的账号和密码，解锁主播端 / 遥控端访问。",
      username: "用户名",
      password: "密码",
      login: "登录",
      contactMe: "联系我",
      attemptsUsed: "已尝试次数：",
      welcome: "欢迎",
      openHost: "打开模式 1（主播端）",
      openRemote: "打开模式 2（遥控端）",
      makeVideo: "制作视频",
      logout: "退出登录",
      awaitingActivation: "等待开通",
      expired: "已过期",
      timeLeft: "剩余时间：",
      language: "语言",
      showPassword: "显示密码",
      errInvalid: "用户名或密码错误",
      errNotActive: "账号未启用",
      errExpired: "账号已过期",
      errTooMany: "尝试次数过多，请稍后再试",
      errTooMany15: "登录尝试过多，请 15 分钟后再试",
      errNetwork: "网络异常，请重试",
    },
    en: {
      docTitle: "TikTokkingDubai Access",
      secureAccess: "Secure Access",
      loginSubtitle: "Enter your assigned credentials to unlock host/remote access.",
      username: "Username",
      password: "Password",
      login: "Log in",
      contactMe: "Contact Me",
      attemptsUsed: "Attempts used: ",
      welcome: "Welcome",
      openHost: "Open Mode 1 (Host)",
      openRemote: "Open Mode 2 (Remote)",
      makeVideo: "Make Video",
      logout: "Logout",
      awaitingActivation: "Awaiting activation",
      expired: "Expired",
      timeLeft: "Time left: ",
      language: "Language",
      showPassword: "Show password",
      errInvalid: "Invalid username or password",
      errNotActive: "Account is not active",
      errExpired: "Account has expired",
      errTooMany: "Too many attempts. Try again shortly.",
      errTooMany15: "Too many login attempts, try again in 15 minutes.",
      errNetwork: "Network issue. Please try again.",
    },
  };

  /* Known server / client error sentences → dictionary keys. */
  const ERR_MAP = {
    "Invalid username or password": "errInvalid",
    "Account is not active": "errNotActive",
    "Account has expired": "errExpired",
    "Too many attempts. Try again shortly.": "errTooMany",
    "Too many login attempts, try again in 15 minutes.": "errTooMany15",
    "Network issue. Please try again.": "errNetwork",
  };

  /* ── Phrase sweep dictionary (mode2 + makevideo) ─────────────────────────
     Keys are English text-node contents, normalised (nbsp → space, U+2011 →
     "-"). Only exact matches translate; everything else stays untouched. */
  const PHRASES = {
    /* — mode2 header / transport — */
    "Remote Control": "遥控面板",
    "Send commands to the host tab on the same origin.": "向同源的主播页面发送指令。",
    "Open 8-seat room": "打开 8 座房间",
    "Open host tab": "打开主播页面",
    "Start host camera": "开启主播摄像头",
    "Camera": "摄像头",
    "Switch front/back": "切换前 / 后置",
    "Mic: On": "麦克风：开",
    "Mic: Off": "麦克风：关",
    "Cam: On": "摄像头：开",
    "Cam: Off": "摄像头：关",
    "Upload BG Tool (Web): On": "上传背景工具（网页）：开",
    "Upload BG Tool (Web): Off": "上传背景工具（网页）：关",
    "Upload BG Tool (Cam): On": "上传背景工具（摄像头）：开",
    "Upload BG Tool (Cam): Off": "上传背景工具（摄像头）：关",
    "Clear BG": "清除背景",
    "Edit Move: On": "编辑移动：开",
    "Edit Move: Off": "编辑移动：关",
    "Save Layout": "保存布局",
    "Reset Layout": "重置布局",
    "Host Capsule: On": "主播胶囊：开",
    "Host Capsule: Off": "主播胶囊：关",
    "Cam Name: On": "摄像头名称：开",
    "Cam Name: Off": "摄像头名称：关",
    "Speak Border: On": "说话边框：开",
    "Speak Border: Off": "说话边框：关",
    "Gift Capsule: On": "礼物胶囊：开",
    "Gift Capsule: Off": "礼物胶囊：关",
    "Gift Card: On": "礼物卡片：开",
    "Gift Card: Off": "礼物卡片：关",
    "Transparent BG: On": "透明背景：开",
    "Transparent BG: Off": "透明背景：关",
    "🎨 Decorate: On": "🎨 装饰：开",
    "🎨 Decorate: Off": "🎨 装饰：关",
    "Cam tools on host": "主播端摄像头工具",
    "Cam visibility": "摄像头显示",
    "Hide Cam": "隐藏摄像头",
    "Cam name visibility": "摄像头名称显示",
    "Hide Cam Name": "隐藏摄像头名称",
    "Cam name capsule": "名称胶囊",
    "Show Name Capsule": "显示名称胶囊",
    "Host text": "主播文字",
    "Hide Host Text": "隐藏主播文字",

    /* — TikTok live detect — */
    "TikTok Live Gift Detect": "TikTok 直播礼物检测",
    "Disconnected": "未连接",
    "TikTok host name (@username)": "TikTok 主播名（@用户名）",
    "Start Detect": "开始检测",
    "Stop Detect": "停止检测",
    "Auto Gift": "自动礼物",
    "Auto Gift: On": "自动礼物：开",
    "Auto Gift: Off": "自动礼物：关",
    "Spam interval (ms)": "刷屏间隔（毫秒）",
    "Select random gift icons": "选择随机礼物图标",
    "Waiting for live gifts...": "等待直播礼物…",

    /* — donate gift menu — */
    "Donate Gift Menu": "打赏礼物菜单",
    "Pick which gift animations appear when you tap": "选择点击",
    "Donate": "打赏",
    ". By default only": "时播放的礼物动画。默认只勾选",
    "are ticked — tick any others you want.": "，其他想要的自行勾选。",
    "Gifts in donate menu": "打赏菜单中的礼物",
    "Select All": "全选",
    "Add custom gift animation": "添加自定义礼物动画",
    "Add Gift": "添加礼物",
    "with transparency also work. Use a same-origin path (e.g.": "（带透明通道）也可以。使用同源路径（如",
    ") or a CORS-enabled link.": "）或支持跨域的链接。",

    /* — auto mode / voice — */
    "Auto Mode": "自动模式",
    "Auto Mode: On": "自动模式：开",
    "Auto Mode: Off": "自动模式：关",
    "Model voice": "模型语音",
    "Test Sound": "测试声音",
    "System default voice": "系统默认语音",
    "AI voice sound": "AI 语音音量",
    "Volume": "音量",
    "Rate": "语速",
    "Pitch": "音调",
    "Air time before next random sentence (seconds)": "下一句随机语音的间隔秒数",
    "VRM idle movement (calm / energetic)": "VRM 待机动作（平静 / 活力）",
    "Amount": "幅度",
    "Speed": "速度",
    "Sentence list (+/-)": "语句列表（+/-）",
    "Order": "顺序",
    "Sequential (1→2→3)": "顺序（1→2→3）",
    "Random": "随机",
    "Gift rules (+/-)": "礼物规则（+/-）",
    "Speak all gifts": "播报所有礼物",
    "+ Add Rule": "+ 添加规则",

    /* — 8-room style editor — */
    "Edit 8-room style": "编辑 8 座房间样式",
    "Seat height (px)": "座位高度（px）",
    "Seat min width (px)": "座位最小宽度（px）",
    "Gap between boxes (px)": "座位间距（px）",
    "Background colors": "背景颜色",
    "Contrast mix (second color strength)": "对比混合（第二颜色强度）",
    "Background transparent %": "背景透明度 %",
    "Plus size (px)": "加号大小（px）",
    "Request size (px)": "请求框大小（px）",
    "Request text (under +)": "请求文字（加号下方）",
    "Request text style": "请求文字样式",
    "Regular": "常规",
    "Medium": "中等",
    "SemiBold": "半粗",
    "Bold": "粗体",
    "Condensed": "窄体",
    "Expanded": "宽体",
    "+ & Invite offset X (px)": "加号与邀请 X 偏移（px）",
    "+ & Invite offset Y (px)": "加号与邀请 Y 偏移（px）",
    "Request text visibility": "请求文字显示",
    "Request: Show": "请求：显示",
    "Request: Hide": "请求：隐藏",
    "Seat points format": "座位点数格式",
    "Full number": "完整数字",
    "Point number size (px)": "点数大小（px）",
    "Point number style": "点数样式",
    "Point number font": "点数字体",
    "Default": "默认",
    "TikTok name size (px)": "TikTok 名称大小（px）",
    "TikTok name style": "TikTok 名称样式",
    "TikTok name font": "TikTok 名称字体",
    "Custom font (applies to all 3 pickers above)": "自定义字体（应用于以上 3 个选择器）",
    "⬆ Upload Font (.ttf / .otf / .woff)": "⬆ 上传字体（.ttf / .otf / .woff）",
    "Room width (px)": "房间宽度（px）",
    "Room height (px)": "房间高度（px）",
    "8-seat border radius (px)": "8 座圆角（px）",
    "8-seat outline (px)": "8 座描边（px）",
    "Room offset X (px)": "房间 X 偏移（px）",
    "Room offset Y (px)": "房间 Y 偏移（px）",
    "Room scale – Style 1 (%)": "房间缩放 – 样式 1（%）",
    "Room offset X – Style 2 (px)": "房间 X 偏移 – 样式 2（px）",
    "Room offset Y – Style 2 (px)": "房间 Y 偏移 – 样式 2（px）",
    "Room width – Style 2 (px)": "房间宽度 – 样式 2（px）",
    "Room scale – Style 2 (%)": "房间缩放 – 样式 2（%）",
    "Seat border radius – Style 2 (px)": "座位圆角 – 样式 2（px）",
    "Request box border radius (px)": "请求框圆角（px）",

    /* — cam editor — */
    "Edit Cam": "编辑摄像头",
    "Cam width (px)": "摄像头宽度（px）",
    "Cam height (px)": "摄像头高度（px）",
    "Cam border radius (px)": "摄像头圆角（px）",
    "Cam zoom (%)": "摄像头缩放（%）",
    "Cam offset X (px)": "摄像头 X 偏移（px）",
    "Cam offset Y (px)": "摄像头 Y 偏移（px）",
    "Closed room cam": "关闭房间摄像头",
    "Blue speaking border": "蓝色说话边框",
    "Auto blink border (no mic needed)": "自动闪烁边框（无需麦克风）",
    "Auto Blink: On": "自动闪烁：开",
    "Auto Blink: Off": "自动闪烁：关",
    "Speaking border radius (px)": "说话边框圆角（px）",

    /* — VRM / animation / firework — */
    "VRM avatar": "VRM 虚拟形象",
    "Default VRM": "默认 VRM",
    "Custom hand angle": "自定义手部角度",
    "Animation Box": "动画框",
    "Animation width (px)": "动画宽度（px）",
    "Animation height (px)": "动画高度（px）",
    "Animation offset X (px)": "动画 X 偏移（px）",
    "Animation offset Y (px)": "动画 Y 偏移（px）",
    "Animation audio (%)": "动画音量（%）",
    "Fade from top (%)": "顶部渐隐（%）",
    "Animation color": "动画颜色",
    "Shadow (colour behind animation)": "阴影（动画背后的颜色）",
    "Shadow: On": "阴影：开",
    "Shadow: Off": "阴影：关",
    "Shadow colour": "阴影颜色",
    "Shadow fade from top (%)": "阴影顶部渐隐（%）",
    "Lion animation version": "狮子动画版本",
    "Show Border": "显示边框",
    "Firework Box": "烟花框",
    "Firework offset X (px)": "烟花 X 偏移（px）",
    "Firework offset Y (px)": "烟花 Y 偏移（px）",

    /* — room / styles / custom reward / codes — */
    "8-seat room": "8 座房间",
    "Closed": "已关闭",
    "Style 1 ▼": "样式 1 ▼",
    "Save Points: ON": "保存点数：开",
    "Save Points: OFF": "保存点数：关",
    "Hide": "隐藏",
    "Custom Reward": "自定义奖励",
    "Reward: ON": "奖励：开",
    "Reward: OFF": "奖励：关",
    "Gift Name: ON": "礼物名称：开",
    "Gift Name: OFF": "礼物名称：关",
    "+ Add Row": "+ 添加一行",
    "Setting Codes": "设置代码",
    "1-line code": "单行代码",
    "💾 Save current setup": "💾 保存当前设置",
    "🔗 Generate code": "🔗 生成代码",
    "Current code (click to copy)": "当前代码（点击复制）",
    "Copy": "复制",
    "Paste a code to add to your list": "粘贴代码以添加到列表",
    "Add to list": "添加到列表",
    "My saved setups": "我保存的设置",
    "Cancel": "取消",
    "OK": "确定",

    /* — custom reward helper text — */
    "Each row maps a": "每行将一个",
    "trigger gift": "触发礼物",
    "→ a": "映射为一个",
    "reward gift": "奖励礼物",
    "Gift Name": "礼物名称",
    "shows/hides the gift names on Mode 1 (default off).": "用于在模式 1 上显示 / 隐藏礼物名称（默认关闭）。",
    "Arrow:": "箭头：",
    "Upload arrow (image / gif / video)": "上传箭头（图片 / GIF / 视频）",
    "Reset ➜": "重置 ➜",
    "Use": "使用",
    "= real TikTok effect (played with libpag on the host).": "＝ 真实 TikTok 特效（由主播端 libpag 播放）。",
    ".webm/.mov": ".webm/.mov",

    /* — makevideo — */
    "Make Video": "制作视频",
    "Your TikTok @name": "您的 TikTok @用户名",
    "Upload Video Background": "上传视频背景",
    "Tap to select video": "点击选择视频",
    "Show Bottom Bar": "显示底栏",
    "Coin Balance (shown in gift panel)": "金币余额（显示在礼物面板）",
    "⚙ Edit Gift Positions": "⚙ 编辑礼物位置",
    "Start": "开始",
    "Floating Overlay Mode": "悬浮叠加模式",
    "Open Settings": "打开设置",
    "For": "如需",
    "full-colour, solid": "全彩、不透明",
    "gift animations (not see-through), enable": "的礼物动画（非透明），请在系统无障碍设置中开启",
    "in Accessibility settings.": "。",
    "Enable Solid Overlay": "启用纯色叠加",
    "A gift strip will float above TikTok.": "礼物栏将悬浮在 TikTok 上方。",
    "You can scroll & tap TikTok freely.": "您可以自由滑动和点击 TikTok。",
    "▶ Go Overlay": "▶ 启动叠加",
    "● Make Video — drag to move": "● 制作视频 — 拖动移动",
    "Combo": "连击",
    "↕ Drag panel up / down to position": "↕ 上下拖动面板定位",
    "✕ Done": "✕ 完成",
    "Gifts": "礼物",
    "Exclusive": "专属",
  };
  for (let i = 1; i <= 6; i++) PHRASES["Style " + i] = "样式 " + i;

  /* Prefix rules for labels whose tail changes live (countdown numbers). */
  const PREFIXES = [
    [/^Next random sentence countdown:/, "下一句随机语音倒计时："],
  ];

  const ZH_VALUES = new Set(Object.values(PHRASES));

  function norm(s) {
    return String(s).replace(/\u00A0/g, " ").replace(/\u2011/g, "-").trim();
  }

  function detectLang() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && DICTS[saved]) return saved;
    } catch (e) { /* private mode */ }
    const nav = String(navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.indexOf("zh") === 0 ? "zh" : "en";
  }

  let lang = detectLang();
  let observer = null;
  let sweepTimer = null;
  /* node → last seen ENGLISH value, so switching back restores exactly that
     (and state flips like "Mic: Off" → "Mic: On" update the original too). */
  const originals = new WeakMap();

  function t(key) {
    return (DICTS[lang] && DICTS[lang][key]) || DICTS.en[key] || key;
  }

  function translateError(message) {
    const key = ERR_MAP[String(message || "").trim()];
    return key ? t(key) : message;
  }

  function translateTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return;
    const core = norm(raw);
    if (ZH_VALUES.has(core)) return; // already translated
    const lead = (raw.match(/^\s*/) || [""])[0];
    const trail = (raw.match(/\s*$/) || [""])[0];
    const zh = PHRASES[core];
    if (zh) {
      originals.set(node, core);
      node.nodeValue = lead + zh + trail;
      return;
    }
    for (const [re, zhPrefix] of PREFIXES) {
      const mm = core.match(re);
      if (mm) {
        originals.set(node, core);
        node.nodeValue = lead + zhPrefix + core.slice(mm[0].length) + trail;
        return;
      }
    }
  }

  function restoreTextNode(node) {
    const orig = originals.get(node);
    if (orig == null) return;
    const raw = node.nodeValue || "";
    const lead = (raw.match(/^\s*/) || [""])[0];
    const trail = (raw.match(/\s*$/) || [""])[0];
    node.nodeValue = lead + orig + trail;
  }

  function makeWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest("script,style,textarea,option")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  function sweepBody() {
    if (lang !== "zh" || !document.body) return;
    const walker = makeWalker(document.body);
    let n;
    while ((n = walker.nextNode())) translateTextNode(n);
  }

  function restoreBody() {
    if (!document.body) return;
    const walker = makeWalker(document.body);
    let n;
    while ((n = walker.nextNode())) restoreTextNode(n);
  }

  function scheduleSweep() {
    if (lang !== "zh") return;
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweepBody, 120);
  }

  function startObserver() {
    if (observer || !document.body || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(scheduleSweep);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function applyTranslations() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    /* Only the portal renames its tab title — mode2/makevideo keep their own
       (their titles are set by the page, not this dictionary). */
    const isSweepPage = document.body && document.body.hasAttribute("data-i18n-sweep");
    if (!isSweepPage) document.title = t("docTitle");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    const sel = document.getElementById("portalLangSelect");
    if (sel) sel.value = lang;

    if (document.body && document.body.hasAttribute("data-i18n-sweep")) {
      if (lang === "zh") {
        sweepBody();
        startObserver();
      } else {
        if (observer) { observer.disconnect(); observer = null; }
        restoreBody();
      }
    }
  }

  function setLang(code) {
    if (!DICTS[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* ignore */ }
    applyTranslations();
  }

  window.PortalI18N = {
    t: t,
    translateError: translateError,
    setLang: setLang,
    applyTranslations: applyTranslations,
    get lang() { return lang; },
  };

  document.addEventListener("DOMContentLoaded", () => {
    const sel = document.getElementById("portalLangSelect");
    if (sel) {
      sel.value = lang;
      sel.addEventListener("change", () => setLang(sel.value));
    }
    applyTranslations();
  });
})();
