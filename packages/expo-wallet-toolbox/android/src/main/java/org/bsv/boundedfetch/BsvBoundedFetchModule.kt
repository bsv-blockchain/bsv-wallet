package org.bsv.boundedfetch

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream

class BoundedRequestOptions : Record {
  @Field var id: String = ""
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: List<List<String>> = emptyList()
  @Field var body: String? = null
  @Field var maxBytes: Int = -1
}

class BsvBoundedFetchModule : Module() {
  private val requests = ConcurrentHashMap<String, BoundedConnection>()
  private val workers = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("BsvBoundedFetch")

    // Register synchronously on the module queue before scheduling network I/O.
    // The subsequent cancel call uses the same queue and sees the receiver.
    AsyncFunction("request") { options: BoundedRequestOptions, promise: Promise ->
      try {
        val url = URL(options.url)
        require(url.protocol == "https" && options.maxBytes in 0..67108864) { "Invalid bounded HTTPS request" }
        val connection = url.openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = 30000
        connection.readTimeout = 30000
        connection.requestMethod = options.method
        options.headers.forEach { header ->
          require(header.size == 2) { "Invalid header" }
          connection.setRequestProperty(header[0], header[1])
        }
        // Explicit encoding disables Android's implicit decompression; count the
        // decoded stream below, including when the server ignores identity.
        connection.setRequestProperty("Accept-Encoding", "identity")
        val receiver = BoundedConnection(connection)
        requests[options.id] = receiver
        workers.execute {
          try {
            receiver.checkActive()
            val upload = options.body?.let { Base64.decode(it, Base64.DEFAULT) }
            if (upload != null) {
              connection.doOutput = true
              connection.setFixedLengthStreamingMode(upload.size)
            }
            receiver.connect()
            if (upload != null) {
              receiver.checkActive()
              connection.outputStream.use { it.write(upload) }
            }
            receiver.checkActive()
            val status = connection.responseCode
            val declaredLength = connection.getHeaderField("Content-Length")?.toLongOrNull()
            if (declaredLength != null && declaredLength > options.maxBytes) {
              throw java.io.IOException("ERR_RESPONSE_TOO_LARGE")
            }
            val body = BoundedBody(options.maxBytes)
            val raw = if (status >= 400) connection.errorStream else connection.inputStream
            raw?.use {
              val stream = when (connection.contentEncoding?.lowercase()) {
                null, "identity" -> it
                "gzip" -> GZIPInputStream(it)
                else -> throw java.io.IOException("Unsupported response encoding")
              }
              stream.use { decoded ->
                val chunk = ByteArray(8192)
                while (true) {
                  receiver.checkActive()
                  val count = decoded.read(chunk)
                  if (count < 0) break
                  // Reject BEFORE appending, with no native-to-JS chunk queue.
                  body.append(chunk, count)
                }
              }
            }
            val headers = connection.headerFields.entries.filter { it.key != null }
              .flatMap { entry -> entry.value.map { listOf(entry.key, it) } }
            promise.resolve(mapOf("status" to status, "headers" to headers,
              "body" to Base64.encodeToString(body.bytes(), Base64.NO_WRAP)))
          } catch (error: Exception) {
            promise.reject("ERR_BOUNDED_FETCH", error.message ?: "Bounded request failed", error)
          } finally {
            requests.remove(options.id)
            connection.disconnect()
          }
        }
      } catch (error: Exception) {
        promise.reject("ERR_BOUNDED_FETCH", error.message ?: "Invalid bounded request", error)
      }
    }

    AsyncFunction("cancel") { id: String -> requests[id]?.cancel(); Unit }

    OnDestroy {
      requests.values.forEach { it.cancel() }
      requests.clear()
      workers.shutdownNow()
    }
  }
}
