package com.maxrace.dash;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * The race log written by the app itself, so a race is recorded whole even when the screen is off and the
 * page is suspended. One line per NMEA sentence, "<epoch ms>\t<sentence>"; phone GPS fixes as
 * "<epoch ms>\t{json}"; notes as "# ...". Appended and flushed every second, synced to the storage every
 * 5 s, so a crash or a dead battery loses a few seconds at most. Starting again with the same folder
 * (the app was closed in the middle of a race) appends to the same file.
 *
 * While recording the file is in the app's own storage (Android › data › com.maxrace.dash › files › Races);
 * when the race is finished it is copied to Documents › MaxRace › Races next to the CSV and the report.
 */
final class RaceLog {
    interface Chunk { void lines(List<String> lines, boolean done, String error); }

    private static final Object lock = new Object();
    private static BufferedWriter w;
    private static FileOutputStream fos;
    private static File file;
    private static String folder;
    private static long lastFlush, lastSync;
    private static ScheduledExecutorService timer;

    private RaceLog() {}

    static String name(String folder) { return folder + " NMEA log.txt"; }

    static File fileFor(Context c, String folder) {
        File base = c.getExternalFilesDir(null);
        if (base == null) base = c.getFilesDir();
        return new File(new File(new File(base, "Races"), folder), name(folder));
    }

    static boolean active() { synchronized (lock) { return w != null; } }

    static String folder() { synchronized (lock) { return folder; } }

    private static String iso(long t) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(t));
    }

    /** Opens (or reopens, appending) the log of this race. */
    static File start(Context c, String fold, String boat) throws IOException {
        synchronized (lock) {
            if (w != null && fold.equals(folder)) return file;
            closeLocked();
            File f = fileFor(c, fold);
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
            boolean resumed = f.exists() && f.length() > 0;
            fos = new FileOutputStream(f, true);
            w = new BufferedWriter(new OutputStreamWriter(fos, StandardCharsets.ISO_8859_1), 65536);
            file = f;
            folder = fold;
            long now = System.currentTimeMillis();
            if (resumed) w.write("# resumed " + iso(now) + "\n");
            else w.write("# MaxRace race log v1\tfolder=" + fold + "\tboat=" + (boat == null ? "" : boat) + "\tstart=" + iso(now) + "\n");
            w.flush();
            lastFlush = lastSync = now;
            timer = Executors.newSingleThreadScheduledExecutor();
            timer.scheduleWithFixedDelay(() -> flush(false), 1, 1, TimeUnit.SECONDS);
            return f;
        }
    }

    static void lines(List<String> lines) {
        long t = System.currentTimeMillis();
        synchronized (lock) {
            if (w == null) return;
            try {
                for (String s : lines) { w.write(Long.toString(t)); w.write('\t'); w.write(s); w.write('\n'); }
            } catch (IOException ignored) {}
        }
    }

    static void gps(long t, String json) {
        synchronized (lock) {
            if (w == null) return;
            try { w.write(t + "\t" + json + "\n"); } catch (IOException ignored) {}
        }
    }

    static void note(String text) {
        synchronized (lock) {
            if (w == null) return;
            try { w.write("# " + System.currentTimeMillis() + " " + text.replace('\n', ' ') + "\n"); } catch (IOException ignored) {}
        }
    }

    static void flush(boolean sync) {
        synchronized (lock) {
            if (w == null) return;
            long now = System.currentTimeMillis();
            try {
                w.flush();
                lastFlush = now;
                if (sync || now - lastSync >= 5000) { fos.getFD().sync(); lastSync = now; }
            } catch (IOException ignored) {}
        }
    }

    private static void closeLocked() {
        if (timer != null) { timer.shutdownNow(); timer = null; }
        if (w != null) {
            try { w.write("# stopped " + iso(System.currentTimeMillis()) + "\n"); w.flush(); fos.getFD().sync(); } catch (IOException ignored) {}
            try { w.close(); } catch (IOException ignored) {}
        }
        w = null;
        fos = null;
    }

    /** Stops writing; returns the file (null when nothing was recording). */
    static File stop() {
        synchronized (lock) {
            File f = file;
            closeLocked();
            file = null;
            folder = null;
            return f;
        }
    }

    /** Copies the finished log to Documents › MaxRace › Races › folder, where the report goes too. */
    static void publish(Context c, File f, String fold) {
        if (f == null || !f.exists()) return;
        ContentResolver cr = c.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, f.getName());
        v.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/MaxRace/Races/" + fold);
        try {
            Uri u = cr.insert(MediaStore.Files.getContentUri("external"), v);
            if (u == null) return;
            try (InputStream in = new FileInputStream(f); OutputStream out = cr.openOutputStream(u)) {
                if (out == null) return;
                byte[] b = new byte[65536];
                int r;
                while ((r = in.read(b)) > 0) out.write(b, 0, r);
            }
        } catch (Exception ignored) {
            // the log stays in the app's own storage
        }
    }

    static void delete(Context c, String fold) {
        File f = fileFor(c, fold);
        if (f.exists()) f.delete();
        File d = f.getParentFile();
        if (d != null) { String[] left = d.list(); if (left != null && left.length == 0) d.delete(); }
    }

    /** Reads the log back for the page, in chunks; AIS sentences and notes are left out (the report does not use them). */
    static void read(Context c, String fold, int chunk, Chunk out) {
        File f = fileFor(c, fold);
        if (!f.exists()) { out.lines(new ArrayList<>(), true, "no native log for this race"); return; }
        flush(false);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.ISO_8859_1), 65536)) {
            List<String> buf = new ArrayList<>();
            String line;
            while ((line = r.readLine()) != null) {
                int i = line.indexOf('\t');
                if (i <= 0 || line.startsWith("#") || i + 1 >= line.length() || line.charAt(i + 1) == '!') continue;
                buf.add(line);
                if (buf.size() >= chunk) { out.lines(buf, false, null); buf = new ArrayList<>(); }
            }
            out.lines(buf, true, null);
        } catch (IOException e) {
            out.lines(new ArrayList<>(), true, e.getMessage());
        }
    }
}
