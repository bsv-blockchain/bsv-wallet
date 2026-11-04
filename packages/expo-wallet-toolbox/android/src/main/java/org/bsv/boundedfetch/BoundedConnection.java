package org.bsv.boundedfetch;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.concurrent.atomic.AtomicBoolean;

/** Cancellation remains effective even before HttpURLConnection is connected. */
public final class BoundedConnection {
  private final HttpURLConnection connection;
  private final AtomicBoolean cancelled = new AtomicBoolean();

  public BoundedConnection(HttpURLConnection connection) { this.connection = connection; }

  public void cancel() {
    cancelled.set(true);
    connection.disconnect();
  }

  public void checkActive() throws IOException {
    if (cancelled.get()) throw new IOException("Bounded request aborted");
  }

  public void connect() throws IOException {
    checkActive();
    connection.connect();
    checkActive();
  }
}
