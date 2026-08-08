package com.qx.yingshi.androidhost;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private AndroidSpiderHost host;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView status = new TextView(this);
        status.setPadding(32, 32, 32, 32);
        status.setText("QX Android Spider Host\nstarting...");
        setContentView(status);
        host = new AndroidSpiderHost(this);
        try {
            host.start();
            status.setText("QX Android Spider Host\nONLINE\n127.0.0.1:" + AndroidSpiderHost.PORT);
        } catch (Exception error) {
            status.setText("QX Android Spider Host\nOFFLINE\n" + error.getMessage());
        }
    }

    @Override
    protected void onDestroy() {
        if (host != null) host.close();
        super.onDestroy();
    }
}
