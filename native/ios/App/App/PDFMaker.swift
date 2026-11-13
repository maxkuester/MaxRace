// Turns the race report (HTML) into an A4 PDF, page by page, with the system print renderer.
import UIKit
import WebKit

final class PDFMaker: NSObject, WKNavigationDelegate {
    private let web: WKWebView
    private var done: ((Data?) -> Void)?

    init(host: UIView, html: String, done: @escaping (Data?) -> Void) {
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 794, height: 1123))
        self.done = done
        super.init()
        web.navigationDelegate = self
        web.alpha = 0.01                     // the print formatter wants a view inside the window
        web.isUserInteractionEnabled = false
        host.insertSubview(web, at: 0)
        web.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.render() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil) }

    private func render() {
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(web.viewPrintFormatter(), startingAtPageAt: 0)
        let paper = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)       // A4 in points
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: paper.insetBy(dx: 30, dy: 36)), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        let n = renderer.numberOfPages
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: n))
        for i in 0..<n {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        finish(n > 0 ? data as Data : nil)
    }

    private func finish(_ d: Data?) {
        web.navigationDelegate = nil
        web.removeFromSuperview()
        let cb = done
        done = nil
        cb?(d)
    }
}
