package com.maxrace.dash;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * The bridge between the dashboard page and Android. Same commands as the iPhone app:
 * page -> app: Capacitor.nativePromise("MaxRace", "post", {cmd, ...})
 *   connect {proto, host, port} / disconnect, gps {on}, save {folder, files, pdf}, share {name, text}, pdfShare {name, html}
 *   recStart {folder, boat} / recStop {discard} / recRead {folder}   the race log written by the app (RaceLog)
 * app -> page: event "mrn" {fn, arg}; the page calls MRN[fn](arg): lines, status, gps, gpsError, saved, rec, recLog
 *
 * While a race is recorded every sentence and GPS fix goes to RaceLog and RecordService keeps the app
 * running with the screen off. While the app is not in front the page gets no sentences (its WebView is
 * paused anyway); at the finish it reads the log back to fill what it missed.
 */
@CapacitorPlugin(
    name = "MaxRace",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class MaxRacePlugin extends Plugin implements LocationListener, SensorEventListener {
    private static final double KN = 1.943844;
    private NetScan scanner;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<String> pending = new ArrayList<>();
    private NmeaSource nmea;
    private boolean gpsOn = false;
    private double heading = -1, declination = 0;
    private final float[] rot = new float[9], ori = new float[3];
    private WebView printView;          // kept until the print dialog has read it
    private volatile boolean front = true;   // the app is in front: sentences go to the page

    @Override
    public void load() {
        scanner = new NetScan(getContext(), st -> { if (front) send("scan", st); });
        nmea = new NmeaSource(getContext(), new NmeaSource.Listener() {
            @Override public void onLines(List<String> lines) {
                RaceLog.lines(lines);
                if (front) synchronized (pending) { pending.addAll(lines); }
            }
            @Override public void onStatus(boolean connected, String error) {
                RaceLog.note(connected ? "source connected" : "source not connected: " + error);
                JSObject o = new JSObject();
                o.put("connected", connected);
                if (error != null) o.put("error", error);
                main.post(() -> send("status", o));
            }
        });
        // sentences go to the page in small batches, ten times a second
        main.postDelayed(new Runnable() {
            @Override public void run() { flush(); main.postDelayed(this, 100); }
        }, 100);
    }

    private void flush() {
        JSArray a;
        synchronized (pending) {
            if (pending.isEmpty()) return;
            a = new JSArray();
            for (String s : pending) a.put(s);
            pending.clear();
        }
        send("lines", a);
    }

    private void send(String fn, Object arg) {
        JSObject o = new JSObject();
        o.put("fn", fn);
        o.put("arg", arg);
        notifyListeners("mrn", o);
    }

    @PluginMethod
    public void post(PluginCall call) {
        JSObject b = call.getData();
        String cmd = b.getString("cmd", "");
        switch (cmd) {
            case "connect":
                nmea.connect(b.getString("proto", "tcp"), b.getString("host", ""), b.getInteger("port", 0));
                break;
            case "disconnect":
                nmea.stop();
                synchronized (pending) { pending.clear(); }
                break;
            case "scan":
                scanner.start();
                break;
            case "scanStop":
                scanner.stop();
                break;
            case "camDir":
                camDir(b.optBoolean("on", false));
                break;
            case "gps":
                if (b.optBoolean("on", false)) {
                    if (getPermissionState("location") != PermissionState.GRANTED) {
                        requestPermissionForAlias("location", call, "gpsPermission");
                        return;
                    }
                    startGps();
                } else stopGps();
                break;
            case "save":
                main.post(() -> saveRace(b));
                break;
            case "share":
                main.post(() -> share(b.getString("name", "MaxRace.txt"), b.getString("text", "").getBytes(StandardCharsets.UTF_8)));
                break;
            case "pdfShare":
                main.post(() -> printPdf(b.getString("name", "MaxRace report.pdf"), b.getString("html", "")));
                break;
            case "recStart":
                if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                    // without it the service still runs, only its notification is hidden
                    requestPermissionForAlias("notifications", call, "recPermission");
                    return;
                }
                recStart(b);
                break;
            case "recStop":
                recStop(b.optBoolean("discard", false));
                break;
            case "recRead":
                recRead(clean(b.getString("folder", "")));
                break;
            default:
                break;
        }
        call.resolve();
    }

    @PermissionCallback
    private void gpsPermission(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) startGps();
        else send("gpsError", "Location access is off for MaxRace. Turn it on in Settings › Apps › MaxRace › Permissions › Location.");
        call.resolve();
    }

    @PermissionCallback
    private void recPermission(PluginCall call) {
        recStart(call.getData());
        call.resolve();
    }

    // ---------- race log written by the app, also with the screen off ----------

    private void recStart(JSObject b) {
        String folder = clean(b.getString("folder", ""));
        if (folder.isEmpty()) folder = "race";
        JSObject o = new JSObject();
        try {
            RaceLog.start(getContext(), folder, b.getString("boat", ""));
            RecordService.start(getContext());
            o.put("on", true);
            o.put("folder", folder);
        } catch (Exception e) {
            o.put("on", false);
            o.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
        }
        main.post(() -> send("rec", o));
    }

    private void recStop(boolean discard) {
        String folder = RaceLog.folder();
        java.io.File f = RaceLog.stop();
        RecordService.stop(getContext());
        if (folder == null) return;
        if (discard) RaceLog.delete(getContext(), folder);
        else new Thread(() -> RaceLog.publish(getContext(), f, folder), "maxrace-log-copy").start();
    }

    private void recRead(String folder) {
        new Thread(() -> RaceLog.read(getContext(), folder, 4000, (lines, done, error) -> {
            JSObject o = new JSObject();
            JSArray a = new JSArray();
            for (String s : lines) a.put(s);
            o.put("lines", a);
            o.put("done", done);
            if (error != null) o.put("error", error);
            main.post(() -> send("recLog", o));
        }), "maxrace-log-read").start();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        front = false;
        synchronized (pending) { pending.clear(); }
        RaceLog.flush(true);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        front = true;
    }

    // ---------- phone GPS and compass ----------

    @SuppressWarnings("MissingPermission")
    private void startGps() {
        main.post(() -> {
            gpsOn = true;
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm == null || !lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                send("gpsError", "The GPS is off. Turn on Location in the Android quick settings.");
                return;
            }
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0f, this, Looper.getMainLooper());
            SensorManager sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            Sensor rv = sm != null ? sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) : null;
            if (rv != null) sm.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
        });
    }

    private void stopGps() {
        gpsOn = false;
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm != null) lm.removeUpdates(this);
        SensorManager sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (sm != null) sm.unregisterListener(this);
        heading = -1;
    }

    @Override
    public void onLocationChanged(Location l) {
        if (!gpsOn) return;
        declination = new GeomagneticField((float) l.getLatitude(), (float) l.getLongitude(), (float) l.getAltitude(), l.getTime()).getDeclination();
        JSObject o = new JSObject();
        o.put("lat", l.getLatitude());
        o.put("lon", l.getLongitude());
        o.put("t", l.getTime());
        if (l.hasAccuracy()) o.put("acc", l.getAccuracy());
        if (l.hasSpeed()) o.put("sog", l.getSpeed() * KN);
        if (l.hasBearing()) o.put("cog", l.getBearing());
        if (heading >= 0) o.put("hdg", heading);
        RaceLog.gps(System.currentTimeMillis(), o.toString());
        if (front) send("gps", o);
    }

    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {
        if (gpsOn) send("gpsError", "The GPS was turned off.");
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        SensorManager.getRotationMatrixFromVector(rot, e.values);
        SensorManager.getOrientation(rot, ori);
        double h = Math.toDegrees(ori[0]) + declination;     // magnetic -> true, top edge of the phone
        heading = ((h % 360) + 360) % 360;
    }

    @Override public void onAccuracyChanged(Sensor s, int a) {}

    // ---------- Targets camera: where the back camera points, true north, 15 times a second ----------
    // The rotation vector gives phone -> world (east, north, up); the camera looks along the phone's -z axis.
    private final float[] camRot = new float[9];
    private long camLast = 0;
    private final SensorEventListener camListener = new SensorEventListener() {
        @Override public void onSensorChanged(SensorEvent e) {
            long now = System.currentTimeMillis();
            if (now - camLast < 66) return;
            camLast = now;
            SensorManager.getRotationMatrixFromVector(camRot, e.values);
            double east = -camRot[2], north = -camRot[5], up = -camRot[8];
            double az = Math.toDegrees(Math.atan2(east, north)) + declination;
            JSObject o = new JSObject();
            o.put("az", ((az % 360) + 360) % 360);
            o.put("pitch", Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, up)))));
            o.put("ref", declination != 0 ? "true" : "mag");
            send("camDir", o);
        }
        @Override public void onAccuracyChanged(Sensor s, int a) {}
    };

    private void camDir(boolean on) {
        main.post(() -> {
            SensorManager sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return;
            sm.unregisterListener(camListener);
            if (!on) return;
            Sensor rv = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (rv == null) { send("camDir", "no rotation sensor"); return; }
            sm.registerListener(camListener, rv, SensorManager.SENSOR_DELAY_GAME);
        });
    }

    // ---------- races in Documents › MaxRace › Races ----------

    private static String clean(String s) {
        String t = (s == null ? "" : s).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "").trim();
        while (t.startsWith(".")) t = t.substring(1);
        return t.length() > 120 ? t.substring(0, 120) : t;
    }

    private static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".gpx")) return "application/gpx+xml";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".pdf")) return "application/pdf";
        return "text/plain";
    }

    private void saveRace(JSObject b) {
        String folder = clean(b.getString("folder", ""));
        if (folder.isEmpty()) folder = "race";
        String rel = Environment.DIRECTORY_DOCUMENTS + "/MaxRace/Races/" + folder;
        ContentResolver cr = getContext().getContentResolver();
        try {
            JSONObject files = b.getJSObject("files", new JSObject());
            Iterator<String> it = files.keys();
            while (it.hasNext()) {
                String name = it.next(), n = clean(name);
                if (n.isEmpty()) continue;
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, n);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime(n));
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                Uri u = cr.insert(MediaStore.Files.getContentUri("external"), v);
                if (u == null) throw new Exception("could not create " + n);
                try (OutputStream os = cr.openOutputStream(u)) {
                    os.write(files.optString(name, "").getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (Exception e) {
            JSObject o = new JSObject();
            o.put("ok", false);
            o.put("error", e.getMessage());
            send("saved", o);
            return;
        }
        // no silent HTML-to-PDF on Android: the report is saved as HTML, "PDF / Share" prints it to PDF
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("dir", "Files › Documents › MaxRace › Races › " + folder);
        o.put("pdf", false);
        send("saved", o);
    }

    private void share(String name, byte[] data) {
        String n = clean(name);
        if (n.isEmpty()) n = "MaxRace.txt";
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            dir.mkdirs();
            File f = new File(dir, n);
            try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(data); }
            Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(mime(n));
            i.putExtra(Intent.EXTRA_STREAM, u);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(i, n));
        } catch (Exception e) {
            Toast.makeText(getContext(), "Could not share the file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // the report through the Android print dialog, where "Save as PDF" makes the file
    private void printPdf(String name, String html) {
        String job = name.replaceAll("\\.pdf$", "");
        WebView w = new WebView(getActivity());
        printView = w;
        w.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                if (pm == null) return;
                PrintAttributes attrs = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build();
                pm.print(job, view.createPrintDocumentAdapter(job), attrs);
            }
        });
        w.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacksAndMessages(null);
        // the app is closed for good: the log so far stays on the device, the page resumes it when reopened
        RaceLog.stop();
        RecordService.stop(getContext());
        nmea.stop();
        stopGps();
    }
}
