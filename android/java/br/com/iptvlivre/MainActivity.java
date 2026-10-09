package br.com.iptvlivre;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * IPTV Livre - cliente para Android TV / Fire TV.
 *
 * O app e um WebView apontado para o servidor Node que roda na sua rede
 * (o servidor e quem tem o catalogo, o proxy de stream e o login).
 * Na primeira abertura o usuario informa o endereco do servidor.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "iptvlivre";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private LinearLayout setup;
    private EditText urlInput;
    private TextView setupMsg;
    private String pendingUrl;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.setStatusBarColor(Color.parseColor("#0b0f17"));
        w.setNavigationBarColor(Color.parseColor("#0b0f17"));

        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        if (saved != null && !saved.isEmpty()) {
            openServer(saved);
        } else {
            showSetup(null);
        }
        immersive();
    }

    /* ---------------- tela de configuracao ---------------- */

    private void showSetup(String prefilled) {
        int pad = (int) (24 * getResources().getDisplayMetrics().density);

        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setGravity(Gravity.CENTER);
        setup.setPadding(pad, pad, pad, pad);
        setup.setBackgroundColor(Color.parseColor("#0b0f17"));

        TextView title = new TextView(this);
        title.setText("IPTV Livre");
        title.setTextColor(Color.parseColor("#e8edf7"));
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        setup.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Endereco do servidor na sua rede");
        sub.setTextColor(Color.parseColor("#8b98b0"));
        sub.setTextSize(15);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subp.topMargin = pad / 3;
        subp.bottomMargin = pad;
        setup.addView(sub, subp);

        urlInput = new EditText(this);
        urlInput.setHint("http://192.168.0.10:8090");
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setTextColor(Color.parseColor("#e8edf7"));
        urlInput.setHintTextColor(Color.parseColor("#5a6a86"));
        urlInput.setBackgroundColor(Color.parseColor("#121826"));
        urlInput.setPadding(pad / 2, pad / 3, pad / 2, pad / 3);
        setup.addView(urlInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setupMsg = new TextView(this);
        setupMsg.setTextColor(Color.parseColor("#ef4444"));
        setupMsg.setTextSize(13);
        setupMsg.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msgp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        msgp.topMargin = pad / 2;
        setup.addView(setupMsg, msgp);

        Button go = new Button(this);
        go.setText("Conectar");
        go.setAllCaps(false);
        LinearLayout.LayoutParams gop = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gop.topMargin = pad / 2;
        setup.addView(go, gop);

        if (prefilled != null) urlInput.setText(prefilled);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { tryConnect(); }
        });
        urlInput.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int a, KeyEvent e) {
                tryConnect();
                return true;
            }
        });

        setContentView(setup);
        urlInput.requestFocus();
    }

    private void tryConnect() {
        String raw = urlInput.getText().toString().trim();
        if (raw.isEmpty()) raw = "http://192.168.0.10:8090";
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw = "http://" + raw;
        if (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);

        setupMsg.setText("testando " + raw + " ...");
        pendingUrl = raw;
        final String target = raw;

        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                boolean reachable;
                try {
                    java.net.HttpURLConnection c =
                        (java.net.HttpURLConnection) new java.net.URL(target + "/health").openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(4000);
                    reachable = c.getResponseCode() == 200;
                    c.disconnect();
                } catch (Exception e) {
                    reachable = false;
                }
                final boolean ok = reachable;
                runOnUiThread(new Runnable() {
                    @Override public void run() { confirmConnect(ok); }
                });
            }
        });
        t.start();
    }

    private void confirmConnect(boolean ok) {
        if (ok) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_URL, pendingUrl).apply();
            Toast.makeText(this, "Conectado", Toast.LENGTH_SHORT).show();
            openServer(pendingUrl);
        } else {
            setupMsg.setText("Nao respondeu. Confira o IP e se o servidor esta ligado.");
        }
    }

    /* ---------------- WebView ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private void openServer(String url) {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0f17"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage dos favoritos
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // o servidor costuma ser http:// na rede local
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // mantem o cookie de sessao do login
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String target) {
                // links externos (logo dos canais) abrem no navegador
                if (target != null && !target.startsWith(url) && !target.contains("/api/")
                        && !target.contains("/proxy")) {
                    try {
                        startActivity(new android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse(target)));
                    } catch (Exception ignored) {}
                    return true;
                }
                return false;
            }
        });

        web.loadUrl(url + "/");
        setContentView(web);
        immersive();
    }

    /* ---------------- janela imersiva ---------------- */

    private void immersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        immersive();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // volta para a tela de troca de servidor
        if (web != null) {
            web.destroy();
            web = null;
        }
        showSetup(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null));
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            onBackPressed();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}