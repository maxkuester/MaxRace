package com.maxrace.dash;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;

import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * NMEA 0183 from the boat's gateway over TCP (client) or UDP (listener), one sentence per line.
 * Reconnects by itself every 3 s when the source is not reachable.
 *
 * The boat Wi-Fi usually has no internet, so Android would send the connection over mobile data:
 * the socket is bound to the Wi-Fi network explicitly.
 */
final class NmeaSource {
    interface Listener {
        void onLines(List<String> lines);
        void onStatus(boolean connected, String error);
    }

    private final Context ctx;
    private final Listener listener;
    private final Object lock = new Object();
    private int gen = 0;
    private Thread worker;
    private Socket tcp;
    private DatagramSocket udp;
    private WifiManager.MulticastLock mlock;

    NmeaSource(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    void connect(String proto, String host, int port) {
        synchronized (lock) {
            stopLocked();
            final int g = gen;
            final boolean isUdp = "udp".equalsIgnoreCase(proto);
            final String h = host == null ? "" : host.trim();
            worker = new Thread(() -> run(g, isUdp, h, port), "maxrace-nmea");
            worker.setDaemon(true);
            worker.start();
        }
    }

    void stop() {
        synchronized (lock) { stopLocked(); }
    }

    private void stopLocked() {
        gen++;
        try { if (tcp != null) tcp.close(); } catch (Exception ignored) {}
        try { if (udp != null) udp.close(); } catch (Exception ignored) {}
        tcp = null;
        udp = null;
        if (mlock != null && mlock.isHeld()) mlock.release();
        mlock = null;
        if (worker != null) worker.interrupt();
        worker = null;
    }

    private boolean alive(int g) {
        synchronized (lock) { return g == gen; }
    }

    private Network wifi() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return n;
        }
        return null;
    }

    private void run(int g, boolean isUdp, String host, int port) {
        if (port <= 0 || port >= 65536) { listener.onStatus(false, "invalid port"); return; }
        while (alive(g)) {
            try {
                if (isUdp) runUdp(g, host, port); else runTcp(g, host, port);
                if (!alive(g)) return;
                listener.onStatus(false, "connection closed by the source");
            } catch (Exception e) {
                if (!alive(g)) return;
                listener.onStatus(false, e.getMessage() != null ? e.getMessage() : e.toString());
            }
            try { Thread.sleep(3000); } catch (InterruptedException e) { return; }
        }
    }

    private void runTcp(int g, String host, int port) throws Exception {
        Network n = wifi();
        Socket s = n != null ? n.getSocketFactory().createSocket() : new Socket();
        synchronized (lock) { if (g != gen) { s.close(); return; } tcp = s; }
        s.setKeepAlive(true);
        s.setSoTimeout(30000);                         // no data for 30 s: reconnect
        s.connect(new InetSocketAddress(host, port), 8000);
        listener.onStatus(true, null);
        InputStream in = s.getInputStream();
        LineBuffer lb = new LineBuffer();
        byte[] buf = new byte[65536];
        int r;
        while (alive(g) && (r = in.read(buf)) >= 0) {
            List<String> lines = lb.feed(buf, r);
            if (!lines.isEmpty()) listener.onLines(lines);
        }
        try { s.close(); } catch (Exception ignored) {}
    }

    private void runUdp(int g, String host, int port) throws Exception {
        WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        DatagramSocket s = new DatagramSocket(null);
        s.setReuseAddress(true);
        s.setBroadcast(true);
        Network n = wifi();
        if (n != null) n.bindSocket(s);
        s.bind(new InetSocketAddress(port));
        synchronized (lock) {
            if (g != gen) { s.close(); return; }
            udp = s;
            if (wm != null) { mlock = wm.createMulticastLock("maxrace"); mlock.setReferenceCounted(false); mlock.acquire(); }
        }
        listener.onStatus(true, null);
        LineBuffer lb = new LineBuffer();
        byte[] buf = new byte[65536];
        DatagramPacket p = new DatagramPacket(buf, buf.length);
        while (alive(g)) {
            p.setLength(buf.length);
            s.receive(p);
            if (!host.isEmpty() && !p.getAddress().getHostAddress().equals(host)) continue;
            int len = p.getLength();
            List<String> lines = lb.feed(buf, len);
            if (len > 0 && buf[len - 1] != '\n') lines.addAll(lb.feed(new byte[]{'\n'}, 1));
            if (!lines.isEmpty()) listener.onLines(lines);
        }
    }

    private static final class LineBuffer {
        private final StringBuilder sb = new StringBuilder();

        List<String> feed(byte[] b, int len) {
            List<String> out = new ArrayList<>();
            sb.append(new String(b, 0, len, StandardCharsets.ISO_8859_1));
            int i;
            while ((i = sb.indexOf("\n")) >= 0) {
                String line = sb.substring(0, i).trim();
                sb.delete(0, i + 1);
                if (!line.isEmpty()) out.add(line);
            }
            if (sb.length() > 65536) sb.setLength(0);
            return out;
        }
    }
}
