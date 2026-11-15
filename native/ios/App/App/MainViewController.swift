// The Capacitor web view with the MaxRace plugin registered, full screen, status bar hidden.
import UIKit
import Capacitor

final class MainViewController: CAPBridgeViewController {
    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MaxRacePlugin())
        view.backgroundColor = .black
        webView?.isOpaque = false
        webView?.backgroundColor = .black
        webView?.scrollView.backgroundColor = .black
        webView?.scrollView.bounces = false
        if #available(iOS 16.4, *) { webView?.isInspectable = true }
    }
}
