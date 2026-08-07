// HARE 桌面殼（W3-2/W3-3）：一扇指向本機 HARE 伺服器（http://localhost:5233）的視窗。
// 殼不含前端碼——伺服器在就載頁；不在就先試著代跑 `node server.mjs`（取代 start-hare.bat
// 的角色），起不來才顯示錯誤畫面＋重連鈕。
// 關閉策略（W3-3 定案＝預設續跑）：伺服器是共用設施（其他 agent 還在用 /mcp），殼關了
// 它繼續跑；設 HARE_KILL_SERVER_ON_EXIT=1 且伺服器是本殼代跑的，退出時才收掉。
// HARE 7a2s4e11 tauri-shell
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

const SERVER_URL: &str = "http://localhost:5233";

fn server_up() -> bool {
  TcpStream::connect_timeout(
    &"127.0.0.1:5233".parse().unwrap(),
    Duration::from_millis(400),
  )
  .is_ok()
}

// 伺服器目錄：HARE_SERVER_DIR 環境變數優先；否則從 exe 往上找 server.mjs
//（dev＝src-tauri/target/debug/ 往上三層即 repo 根；打包安裝另設環境變數）
fn server_dir() -> Option<PathBuf> {
  if let Ok(d) = std::env::var("HARE_SERVER_DIR") {
    let p = PathBuf::from(d);
    if p.join("server.mjs").exists() {
      return Some(p);
    }
  }
  let exe = std::env::current_exe().ok()?;
  let mut p = exe.as_path();
  for _ in 0..6 {
    p = p.parent()?;
    if p.join("server.mjs").exists() {
      return Some(p.to_path_buf());
    }
  }
  None
}

// 代跑伺服器：回傳子行程 pid（僅本殼代跑者，退出收尾時對帳用）
fn spawn_server() -> Option<u32> {
  let dir = server_dir()?;
  let mut cmd = Command::new("node");
  cmd.arg("server.mjs").current_dir(&dir);
  #[cfg(windows)]
  cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不彈黑窗
  cmd.spawn().ok().map(|c| c.id())
}

// 伺服器營運控制（2026-07-18 使用者指示：主機是共用服務，匣＝營運面板）——
// 停止＝掃 5233 監聽者 taskkill（不限本殼代跑者：面板就是給主機管理者用的）
fn server_pid() -> Option<u32> {
  let out = {
    let mut c = Command::new("netstat");
    c.args(["-ano"]);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c.output().ok()?
  };
  let txt = String::from_utf8_lossy(&out.stdout);
  for line in txt.lines() {
    if line.contains(":5233") && line.contains("LISTENING") {
      if let Some(pid) = line.split_whitespace().last().and_then(|s| s.parse::<u32>().ok()) {
        return Some(pid);
      }
    }
  }
  None
}

fn stop_server() {
  if let Some(pid) = server_pid() {
    let mut c = Command::new("taskkill");
    c.args(["/F", "/T", "/PID", &pid.to_string()]);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let _ = c.status();
  }
}

// 動態匣圖示（2026-07-18 使用者指示）：綠圓＝伺服器運行、紅圓＝未連線，白 H 標記——
// 工作列一眼可辨（第三方上不了 Windows 天氣那格，匣圖示是等價形態）
fn status_icon(up: bool) -> tauri::image::Image<'static> {
  let n: u32 = 32;
  let mut buf = vec![0u8; (n * n * 4) as usize];
  let (r, g, b) = if up { (22u8, 163u8, 74u8) } else { (220u8, 38u8, 38u8) };
  let c = (n as f32 - 1.0) / 2.0;
  let rad = c - 0.5;
  for y in 0..n {
    for x in 0..n {
      let dx = x as f32 - c;
      let dy = y as f32 - c;
      let i = ((y * n + x) * 4) as usize;
      if (dx * dx + dy * dy).sqrt() <= rad {
        // 白 H：兩豎（x 10..13、19..22，y 9..23）＋橫槓（y 14..18、x 13..19）
        let h = (y >= 9 && y < 23 && ((x >= 10 && x < 13) || (x >= 19 && x < 22)))
          || (y >= 14 && y < 18 && x >= 13 && x < 19);
        let (pr, pg, pb) = if h { (255, 255, 255) } else { (r, g, b) };
        buf[i] = pr; buf[i + 1] = pg; buf[i + 2] = pb; buf[i + 3] = 255;
      }
    }
  }
  tauri::image::Image::new_owned(buf, n, n)
}

// 迷你狀態浮窗（2026-07-18 使用者指示）：左鍵匣圖示 toggle；右下角、置頂、不進工作列。
// 內容＝內嵌 HTML（不依賴伺服器——斷線時也要能顯示紅燈），每 5 秒輪詢 /api/dash；
// 控制（啟動/停止/重啟）走匣右鍵選單，浮窗純顯示。
// 按鈕走 hare:// 假連結導航，Rust on_navigation 攔截執行（無 IPC 頁的指令通道——
// 斷線時「啟動」也要能按）。外觀依 D:\kcgboot 儀錶板（2026-07-18 使用者指示）：
// 深綠底 #10241e、亮綠 #6fbf8e/暖紅 #e07a62 狀態、等寬數字、無框＋自家標題列
//（●HARE＋─ 收起），拖標題＝hare://drag → Rust start_dragging。
const MINI_JS: &str = r#"
document.documentElement.innerHTML =
  '<body style="margin:0;font-family:system-ui;background:#071a33;color:#e8f1fb;overflow:hidden;user-select:none">'+
  '<div id="hd" style="display:flex;align-items:center;gap:5px;padding:7px 10px 4px;cursor:move">'+
  '<span id="dot" style="color:#7a93b5;font-size:13px">●</span>'+
  '<span style="font-size:12.5px;font-weight:800;letter-spacing:.5px">HARE</span>'+
  '<span id="st" style="font-size:11px;color:#7a93b5">…</span>'+
  '<span style="flex:1"></span>'+
  '<a href="hare://hide" style="color:#7a93b5;text-decoration:none;font-weight:700;padding:0 4px">─</a>'+
  '</div>'+
  '<div id="rows" style="padding:2px 10px 4px;display:flex;flex-direction:column;gap:4px;font-size:12px"></div>'+
  '<div style="padding:4px 10px 9px;display:flex;gap:5px" id="btns">'+
  btn('board','白板')+ btn('start','啟動')+ btn('stop','停止')+ btn('restart','重啟')+
  '</div></body>';
document.getElementById('hd').addEventListener('mousedown', function(e) {
  if (e.target.closest('a')) return;
  location.href = 'hare://drag';
});
function btn(id, label) {
  return '<a id="b_'+id+'" href="hare://'+id+'" style="flex:1;text-align:center;text-decoration:none;'+
    'color:#fff;background:#1684c5;border-radius:7px;padding:4px 0;font-size:11.5px;font-weight:700">'+label+'</a>';
}
function setBtn(id, on) {
  var b = document.getElementById('b_'+id);
  if (!b) return;
  b.style.background = on ? '#1684c5' : '#122844';
  b.style.color = on ? '#fff' : '#4f6b8f';
  b.style.pointerEvents = on ? 'auto' : 'none';
}
function setAll(on) { ['board','start','stop','restart'].forEach(function(i){ setBtn(i, on); }); }
function row(k, v) { return '<div style="display:flex;justify-content:space-between;gap:8px">'+
  '<span style="color:#7a93b5">'+k+'</span>'+
  '<span style="font-family:Consolas,monospace;font-size:11.5px">'+v+'</span></div>'; }
// 動作回饋（2026-07-18 使用者回報按了沒狀態）：按下即「處理中…」黃點＋鎖鈕，
// 並以 0.7/1.5/2.5/4 秒短促刷新取代等 5 秒輪詢
function pending(label) {
  var dot = document.getElementById('dot');
  var st = document.getElementById('st');
  dot.style.color = '#e0b062'; st.textContent = label;
  setAll(false);
  [700, 1500, 2500, 4000].forEach(function(ms){ setTimeout(tick, ms); });
}
async function tick() {
  var rows = document.getElementById('rows');
  var dot = document.getElementById('dot');
  var st = document.getElementById('st');
  var up = false;
  try {
    var r = await fetch('http://localhost:5233/api/dash', { cache: 'no-store' });
    var d = await r.json();
    up = true;
    var ut = Math.floor(d.uptimeSec/3600)+'h'+String(Math.floor((d.uptimeSec%3600)/60)).padStart(2,'0')+'m';
    dot.style.color = '#0f9d6b'; st.textContent = '運行中';
    rows.innerHTML = row('版本', 'v'+d.version+' · '+ut)+
      row('任務', '開放 '+(d.openTasks == null ? '—' : d.openTasks)+' · 待裁定 '+(d.pendingPerms == null ? '—' : d.pendingPerms));
  } catch (e) {
    dot.style.color = '#e05d4f'; st.textContent = '未連線';
    rows.innerHTML = row('版本', '—')+ row('任務', '—');
  }
  setBtn('board', up); setBtn('stop', up); setBtn('restart', up); setBtn('start', !up);
}
document.getElementById('b_start').addEventListener('click', function(){ pending('啟動中…'); });
document.getElementById('b_stop').addEventListener('click', function(){ pending('停止中…'); });
document.getElementById('b_restart').addEventListener('click', function(){ pending('重啟中…'); });
tick(); setInterval(tick, 5000);
"#;

fn toggle_mini(app: &tauri::AppHandle) {
  if let Some(w) = app.get_webview_window("mini") {
    if w.is_visible().unwrap_or(false) { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_focus(); }
    return;
  }
  // 原生標題列（2026-07-18 使用者回饋：無法移動、太大）：可拖曳、✕＝縮起（全域
  // CloseRequested 攔截）；按鈕列指令走 hare:// 導航攔截
  let nav_handle = app.clone();
  let built = tauri::WebviewWindowBuilder::new(app, "mini",
      tauri::WebviewUrl::External("about:blank".parse().unwrap()))
    .title("HARE 狀態")
    .inner_size(280.0, 116.0)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .on_navigation(move |url| {
      if url.scheme() != "hare" { return true; }
      match url.host_str().unwrap_or("") {
        "board" => {
          if let Some(w) = nav_handle.get_webview_window("main") {
            let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
          }
        }
        "start" => { if !server_up() { spawn_server(); } }
        "stop" => stop_server(),
        "restart" => {
          stop_server();
          std::thread::sleep(Duration::from_millis(600));
          spawn_server();
        }
        // 無框自家標題列（KCG 外觀）：拖曳與收起
        "drag" => { if let Some(w) = nav_handle.get_webview_window("mini") { let _ = w.start_dragging(); } }
        "hide" => { if let Some(w) = nav_handle.get_webview_window("mini") { let _ = w.hide(); } }
        _ => {}
      }
      false // hare:// 指令一律取消導航（頁面不跳走）
    })
    .build();
  if let Ok(w) = built {
    // 首開靠右下（工作列上方留邊距）；之後拖到哪記到哪（toggle 只 hide/show）
    if let Ok(Some(mon)) = w.current_monitor() {
      let ms = mon.size();
      let sf = mon.scale_factor();
      let (ww, wh) = (264.0 * sf, 170.0 * sf);
      let _ = w.set_position(tauri::PhysicalPosition::new(
        (ms.width as f64 - ww - 16.0 * sf) as i32,
        (ms.height as f64 - wh - 60.0 * sf) as i32,
      ));
    }
    let _ = w.eval(MINI_JS);
    let _ = w.show();
    let _ = w.set_focus();
  }
}

// 錯誤畫面（inline HTML，零外部資源）：伺服器起不來時顯示＋重連鈕
fn show_error_page(win: &tauri::WebviewWindow) {
  let html = r#"
    document.documentElement.innerHTML =
      '<body style="font-family:system-ui;background:#071a33;color:#e8eef6;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h2>連不上 HARE 伺服器</h2>' +
      '<p style="opacity:.75">http://localhost:5233 沒有回應。請確認伺服器已啟動' +
      '（start-hare.bat 或 node server.mjs），或設定 HARE_SERVER_DIR 讓本視窗代跑。</p>' +
      '<button onclick="location.replace(&quot;http://localhost:5233&quot;)" ' +
      'style="padding:8px 22px;font-size:15px;border-radius:8px;border:0;' +
      'background:#1684c5;color:#fff;cursor:pointer">重新連線</button></div></body>';
  "#;
  let _ = win.eval(html);
}

struct SpawnedServer(Mutex<Option<u32>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // 單例鎖：重複啟動＝把既有視窗召到前景（必須第一個註冊）
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
      }
    }))
    // 視窗狀態記憶：大小／位置跨啟動保留（自動存於 app data）
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .manage(SpawnedServer(Mutex::new(None)))
    // 關窗＝縮到系統匣（2026-07-18 使用者指示：商業軟體形態）；結束走匣選單
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // 系統匣（W3-2 可選項→2026-07-18 使用者指示補上）：圖示＋開啟白板/結束選單，
      // 提示文字每 15 秒更新後端狀態；左鍵點圖示＝召回視窗
      let show = MenuItem::with_id(app, "show", "開啟白板", true, None::<&str>)?;
      let sv_start = MenuItem::with_id(app, "sv_start", "啟動伺服器", true, None::<&str>)?;
      let sv_stop = MenuItem::with_id(app, "sv_stop", "停止伺服器", true, None::<&str>)?;
      let sv_restart = MenuItem::with_id(app, "sv_restart", "重啟伺服器", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "結束（伺服器依策略續跑）", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show, &sv_start, &sv_stop, &sv_restart, &quit])?;
      let bring_up = |app: &tauri::AppHandle| {
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.show();
          let _ = w.unminimize();
          let _ = w.set_focus();
        }
      };
      TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("HARE")
        .on_menu_event(move |app, ev| match ev.id.as_ref() {
          "show" => bring_up(app),
          // 伺服器營運（主機管理者面板）：啟動/停止/重啟；儀錶板走板內 ⚙ 設定
          //（匣直達項 2026-07-18 使用者指示移除）
          "sv_start" => { if !server_up() { spawn_server(); } }
          "sv_stop" => stop_server(),
          "sv_restart" => {
            stop_server();
            std::thread::sleep(Duration::from_millis(600));
            spawn_server();
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
          let app = tray.app_handle();
          match ev {
            // 左鍵＝迷你狀態浮窗 toggle（2026-07-18 使用者指示）。
            // Click 事件按下/放開各發一次（使用者回報「閃現就消失」＝toggle 連按兩下）
            // ——只認放開（Up）
            TrayIconEvent::Click { button: tauri::tray::MouseButton::Left,
              button_state: tauri::tray::MouseButtonState::Up, .. } => toggle_mini(app),
            // 雙擊＝開白板主視窗
            TrayIconEvent::DoubleClick { .. } => {
              if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
              }
            }
            _ => {}
          }
        })
        .build(app)?;
      // 匣圖示＋提示＝後端狀態（輪詢 10 秒）：綠圓運行中/紅圓未連線；狀態變更才換圖示防閃爍
      {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          let mut last: Option<bool> = None;
          loop {
            let up = server_up();
            if let Some(tray) = handle.tray_by_id("main") {
              if last != Some(up) {
                let _ = tray.set_icon(Some(status_icon(up)));
                last = Some(up);
              }
              let st = if up { "HARE｜伺服器：運行中" } else { "HARE｜伺服器：未連線" };
              let _ = tray.set_tooltip(Some(st));
            }
            std::thread::sleep(Duration::from_secs(10));
          }
        });
      }
      // 伺服器生命週期（W3-3）：不在→代跑→輪詢等它上線→導頁；仍不在→錯誤畫面
      let handle = app.handle().clone();
      std::thread::spawn(move || {
        if !server_up() {
          if let Some(pid) = spawn_server() {
            if let Some(st) = handle.try_state::<SpawnedServer>() {
              *st.0.lock().unwrap() = Some(pid);
            }
          }
          for _ in 0..40 {
            if server_up() {
              break;
            }
            std::thread::sleep(Duration::from_millis(250));
          }
        }
        if let Some(win) = handle.get_webview_window("main") {
          if server_up() {
            // 帶時間參數繞過 WebView2 快取（2026-07-18 舊 bundle 事故：使用者視窗
            // 一直吃到快取的舊 index.html）——每次啟動必抓最新前端
            let ts = std::time::SystemTime::now()
              .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = win.eval(&format!("location.replace('{SERVER_URL}/?b={ts}')"));
          } else {
            show_error_page(&win);
          }
        }
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // 退出收尾：預設續跑；HARE_KILL_SERVER_ON_EXIT=1 且是本殼代跑的才收
      if let tauri::RunEvent::Exit = event {
        let kill = std::env::var("HARE_KILL_SERVER_ON_EXIT").ok().as_deref() == Some("1");
        if kill {
          if let Some(st) = app.try_state::<SpawnedServer>() {
            if let Some(pid) = *st.0.lock().unwrap() {
              #[cfg(windows)]
              let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000)
                .status();
              #[cfg(not(windows))]
              let _ = Command::new("kill").arg(pid.to_string()).status();
            }
          }
        }
      }
    });
}
