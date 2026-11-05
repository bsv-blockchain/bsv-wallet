package org.bsv.boundedfetch;

import java.net.HttpURLConnection;
import java.net.URL;

public class BoundedConnectionTest {
  static class FakeConnection extends HttpURLConnection {
    boolean started;
    FakeConnection() throws Exception { super(new URL("https://example.test")); }
    public void connect() { started = true; }
    public void disconnect() {}
    public boolean usingProxy() { return false; }
  }
  public static void main(String[] args) throws Exception {
    FakeConnection connection = new FakeConnection();
    BoundedConnection request = new BoundedConnection(connection);
    // cancel() runs while the worker is still queued. disconnect() alone is a
    // no-op here, matching Android's unconnected HttpURLConnection behavior.
    request.cancel();
    try { request.connect(); throw new AssertionError("cancelled receiver started"); }
    catch (java.io.IOException expected) {}
    if (connection.started) throw new AssertionError("HTTP started after cancellation");
    try { request.checkActive(); throw new AssertionError("cancelled receiver resumed"); }
    catch (java.io.IOException expected) {}
    System.out.println("BoundedConnection cancellation tests passed");
  }
}
