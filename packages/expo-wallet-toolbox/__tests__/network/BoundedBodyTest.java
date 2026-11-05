package org.bsv.boundedfetch;
import java.util.Arrays;
public class BoundedBodyTest {
  public static void main(String[] args) throws Exception {
    BoundedBody body = new BoundedBody(3);
    body.append(new byte[]{1, 2}, 2);
    try { body.append(new byte[]{3, 4}, 2); throw new AssertionError("accepted oversized body"); }
    catch (java.io.IOException expected) {}
    if (!Arrays.equals(body.bytes(), new byte[]{1, 2})) throw new AssertionError("oversized bytes were buffered");
    body.append(new byte[]{3}, 1);
    if (!Arrays.equals(body.bytes(), new byte[]{1, 2, 3})) throw new AssertionError("wrong body");
    System.out.println("BoundedBody Java tests passed");
  }
}
