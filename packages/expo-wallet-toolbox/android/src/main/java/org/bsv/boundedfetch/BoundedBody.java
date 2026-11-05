package org.bsv.boundedfetch;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Counts decoded response bytes before they enter the accumulated body. */
public final class BoundedBody {
  private final int limit;
  private final ByteArrayOutputStream body = new ByteArrayOutputStream();

  public BoundedBody(int limit) { this.limit = limit; }

  public void append(byte[] chunk, int count) throws IOException {
    if (count > limit - body.size()) throw new IOException("ERR_RESPONSE_TOO_LARGE");
    body.write(chunk, 0, count);
  }

  public byte[] bytes() { return body.toByteArray(); }
}
