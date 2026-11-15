package com.maxrace.dash;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// "Find": looks for the instrument data on the boat Wi-Fi for someone who does not know the gateway's address.
// Every address of the phone's network (/24) on the ports NMEA gateways use, over TCP, while listening for UDP
// broadcasts; each answer is recognised (NMEA 0183, AIS only, raw NMEA 2000, Signal K, open but silent).
// The same rules as scan.js in the computer program and NetScan in the iPhone app.
final class NetScan {
    interface Listener { void onState(JSONObject st); }

    static final int[] TCP_PORTS = { 10110, 2000, 1456, 60001, 39150, 3000, 2002, 1457, 60002, 2001, 5000, 5001, 4000, 8888, 6000, 2947, 23 };
    static final int[] UDP_PORTS = { 10110, 2000, 1456, 1457, 2002, 60002, 5000, 6000 };

    private final Context ctx;
    private final Listener listener;
    private final Object lock = new Object();
    private int gen = 0;
    private boolean running = false;
    private final AtomicInteger done = new AtomicInteger();
    private int total = 0;
    private String netName = "", myIp = "", error = null;
    private final List<JSONObject> found = new ArrayList<>();
    private final List<DatagramSocket> udp = new ArrayList<>();
    private ExecutorService pool;
    private long lastEmit = 0;

    NetScan(Context ctx, Listener l) { this.ctx = ctx; this.listener = l; }

    void stop() {
        synchronized (lock) { gen++; running = false; closeUdp(); if (pool != null) pool.shutdownNow(); }
        emit(true);
    }

    void start() {
        final int g;
        synchronized (lock) {
            gen++; g = gen;
            closeUdp(); if (pool != null) pool.shutdownNow();
            found.clear(); done.set(0); error = null; total = 0; netName = ""; myIp = "";
        }
        Network n = wifi();
        String ip = n != null ? address(n) : null;
        if (ip == null) {
            synchronized (lock) { running = false; error = "This phone is not on a Wi-Fi network. Join the boat Wi-Fi first."; }
            emit(true);
            return;
        }
        String base = ip.substring(0, ip.lastIndexOf('.'));
        final List<String[]> jobs = new ArrayList<>();
        for (int port : TCP_PORTS) for (int i = 1; i < 255; i++) jobs.add(new String[] { base + "." + i, String.valueOf(port) });
        synchronized (lock) { netName = base + ".0/24"; myIp = ip; total = jobs.size(); running = true; pool = Executors.newFixedThreadPool(64); }
        openUdp(g, n);
        emit(true);
        final ExecutorService p = pool;
        for (final String[] j : jobs) p.execute(() -> { if (alive(g)) probe(g, n, j[0], Integer.parseInt(j[1])); done.incrementAndGet(); emit(false); });
        new Thread(() -> {
            p.shutdown();
            try { p.awaitTermination(5, TimeUnit.MINUTES); Thread.sleep(1500); } catch (InterruptedException e) { return; }
            synchronized (lock) { if (g != gen) return; running = false; closeUdp(); }
            emit(true);
        }).start();
    }

    private boolean alive(int g) { synchronized (lock) { return g == gen && running; } }

    private void probe(int g, Network n, String host, int port) {
        Socket s = null;
        try {
            s = n.getSocketFactory().createSocket();
            s.connect(new InetSocketAddress(host, port), 800);
            if (port == 3000) {
                OutputStream o = s.getOutputStream();
                o.write(("GET /signalk HTTP/1.0\r\nHost: " + host + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                o.flush();
            }
            s.setSoTimeout(500);
            InputStream in = s.getInputStream();
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[2048];
            long until = System.currentTimeMillis() + 2500;
            while (System.currentTimeMillis() < until && sb.length() < 4096) {
                try {
                    int k = in.read(buf);
                    if (k < 0) break;
                    sb.append(new String(buf, 0, k, StandardCharsets.ISO_8859_1));
                } catch (java.net.SocketTimeoutException t) { /* keep waiting until the time is up */ }
            }
            if (!alive(g)) return;
            String text = sb.toString();
            JSONObject f = classify(text);
            if (f == null) { f = new JSONObject(); f.put("kind", "open"); f.put("what", new JSONArray()); f.put("types", new JSONArray()); f.put("score", 1); f.put("sample", ""); }
            else f.put("sample", firstSentence(text));
            f.put("proto", "tcp"); f.put("host", host); f.put("port", port);
            add(g, f);
        } catch (Exception e) {
            // nothing there
        } finally {
            try { if (s != null) s.close(); } catch (Exception e) {}
        }
    }

    private void openUdp(int g, Network n) {
        for (final int port : UDP_PORTS) {
            try {
                final DatagramSocket u = new DatagramSocket(null);
                u.setReuseAddress(true);
                u.setSoTimeout(400);
                u.bind(new InetSocketAddress(port));
                try { n.bindSocket(u); } catch (Exception e) {}
                synchronized (lock) { udp.add(u); }
                new Thread(() -> {
                    byte[] buf = new byte[4096];
                    while (alive(g)) {
                        try {
                            DatagramPacket pk = new DatagramPacket(buf, buf.length);
                            u.receive(pk);
                            String text = new String(pk.getData(), 0, pk.getLength(), StandardCharsets.ISO_8859_1);
                            JSONObject f = classify(text + "\n" + text);
                            if (f == null) continue;
                            f.put("proto", "udp"); f.put("host", pk.getAddress().getHostAddress()); f.put("port", port); f.put("sample", firstSentence(text));
                            add(g, f);
                        } catch (java.net.SocketTimeoutException t) {
                            // keep listening
                        } catch (Exception e) { return; }
                    }
                }).start();
            } catch (Exception e) {
                // that port is taken on this phone: skip it
            }
        }
    }

    private void closeUdp() { for (DatagramSocket u : udp) try { u.close(); } catch (Exception e) {} udp.clear(); }

    private void add(int g, JSONObject f) {
        synchronized (lock) {
            if (g != gen) return;
            String k = f.optString("proto") + " " + f.optString("host") + ":" + f.optInt("port");
            int at = -1;
            for (int i = 0; i < found.size(); i++) {
                JSONObject x = found.get(i);
                if ((x.optString("proto") + " " + x.optString("host") + ":" + x.optInt("port")).equals(k)) { at = i; break; }
            }
            if (at >= 0) { if (f.optInt("score") > found.get(at).optInt("score")) found.set(at, f); }
            else found.add(f);
            found.sort((a, b) -> b.optInt("score") - a.optInt("score"));
        }
        emit(true);
    }

    private void emit(boolean force) {
        long now = System.currentTimeMillis();
        JSONObject o = new JSONObject();
        synchronized (lock) {
            if (!force && now - lastEmit < 300) return;
            lastEmit = now;
            try {
                o.put("running", running); o.put("done", done.get()); o.put("total", total);
                o.put("net", netName); o.put("ip", myIp);
                JSONArray a = new JSONArray(); for (JSONObject f : found) a.put(f); o.put("found", a);
                if (error != null) o.put("error", error);
            } catch (Exception e) { return; }
        }
        listener.onState(o);
    }

    private static final Pattern NMEA = Pattern.compile("[$!]([A-Z]{2})([A-Z]{3}),");
    private static final Pattern N2K = Pattern.compile("\\d\\d:\\d\\d:\\d\\d\\.\\d{3} [RT] [0-9A-F]{8}");
    private static final Pattern SK = Pattern.compile("signalk-ws|\"signalk\"|signalk-http", Pattern.CASE_INSENSITIVE);

    // what a few kilobytes from a source are, and in words for the list (same as scan.js)
    static JSONObject classify(String text) {
        try {
            TreeSet<String> types = new TreeSet<>();
            int n = 0;
            Matcher m = NMEA.matcher(text);
            while (m.find()) { types.add(m.group(2)); n++; }
            List<String> what = new ArrayList<>();
            if (hasAny(types, "MWV", "MWD", "VWR", "VWT")) what.add("wind");
            if (hasAny(types, "HDT", "HDG", "HDM")) what.add("heading");
            if (hasAny(types, "VHW")) what.add("boat speed");
            if (hasAny(types, "RMC", "GGA", "GLL", "VTG")) what.add("GPS");
            if (hasAny(types, "DPT", "DBT")) what.add("depth");
            if (hasAny(types, "VDM", "VDO")) what.add("AIS");
            if (hasAny(types, "PCDIN")) what.add("NMEA 2000 inside 0183");
            JSONObject o = new JSONObject();
            if (n >= 2) {
                boolean inst = hasAny(types, "MWV", "MWD", "HDT", "HDG", "HDM", "VHW");
                o.put("kind", inst ? "nmea" : (what.size() == 1 && what.get(0).equals("AIS") ? "ais" : "nmea"));
                o.put("what", new JSONArray(what)); o.put("types", new JSONArray(new ArrayList<>(types)));
                o.put("score", (inst ? 100 : 40) + what.size() * 5 + Math.min(n, 20));
                return o;
            }
            if (N2K.matcher(text).find()) { o.put("kind", "n2k"); o.put("what", new JSONArray().put("NMEA 2000 (raw)")); o.put("types", new JSONArray()); o.put("score", 10); return o; }
            if (SK.matcher(text).find()) { o.put("kind", "signalk"); o.put("what", new JSONArray().put("Signal K")); o.put("types", new JSONArray()); o.put("score", 30); return o; }
        } catch (Exception e) {}
        return null;
    }
    private static boolean hasAny(TreeSet<String> s, String... k) { for (String x : k) if (s.contains(x)) return true; return false; }
    private static String firstSentence(String t) { for (String l : t.split("\\r?\\n")) if (l.startsWith("$") || l.startsWith("!")) return l; return ""; }

    private Network wifi() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) return n;
        }
        return null;
    }
    private String address(Network n) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        LinkProperties lp = cm != null ? cm.getLinkProperties(n) : null;
        if (lp == null) return null;
        for (LinkAddress a : lp.getLinkAddresses()) if (a.getAddress() instanceof Inet4Address) return a.getAddress().getHostAddress();
        return null;
    }
}
