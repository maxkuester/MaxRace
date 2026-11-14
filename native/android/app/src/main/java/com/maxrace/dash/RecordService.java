package com.maxrace.dash;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps MaxRace running while a race is recorded, also with the screen off or another app in front:
 * a foreground service (the notification "MaxRace sta registrando la regata"), a partial wake lock so the
 * processor does not sleep, and a Wi-Fi lock so the boat Wi-Fi stays up. The work itself (NMEA socket,
 * GPS, RaceLog) stays in MaxRacePlugin; this service only stops Android from suspending or killing the app.
 */
public class RecordService extends Service {
    private static final String CHANNEL = "race";
    private static final int ID = 31;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    static void start(Context c) {
        ContextCompat.startForegroundService(c, new Intent(c, RecordService.class));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, RecordService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Registrazione regata", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Visibile mentre MaxRace registra una regata");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_rec)
            .setContentTitle("MaxRace sta registrando la regata")
            .setContentText("Registra anche a schermo spento. Termina la regata nell'app.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pi)
            .build();
        // connectedDevice: the boat gateway over the network; location as well when the phone GPS may be used
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        try {
            startForeground(ID, n, type);
        } catch (Exception e) {
            try {
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } catch (Exception e2) {
                RaceLog.note("foreground service refused: " + e2);
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MaxRace:race");
                wake.setReferenceCounted(false);
                wake.acquire(12 * 3600 * 1000L);        // released at the finish; 12 h at most
            }
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                @SuppressWarnings("deprecation")
                WifiManager.WifiLock l = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MaxRace:race");
                wifi = l;
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        }
        return START_NOT_STICKY;     // if Android kills the app anyway there is nothing here to restart
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
