// MaxRace for iPhone and iPad: the same dashboard as the desktop program, in a full-screen web view,
// with the parts a web page cannot do on iOS done natively: NMEA over TCP/UDP, the phone GPS,
// saving races to the Files app and making the report PDF.
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.backgroundColor = .black
        w.rootViewController = DashViewController()
        w.makeKeyAndVisible()
        window = w
        application.isIdleTimerDisabled = true   // the screen stays on while racing
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        application.isIdleTimerDisabled = true
    }
}
