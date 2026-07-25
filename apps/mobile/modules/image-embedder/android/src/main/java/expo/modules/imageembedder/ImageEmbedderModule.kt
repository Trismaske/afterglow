package expo.modules.imageembedder

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.imageembedder.ImageEmbedder
import com.google.mediapipe.tasks.vision.imageembedder.ImageEmbedder.ImageEmbedderOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * MediaPipe Image Embedder (MobileNetV3-large, bundled asset) — the m0.8
 * grouping feature (docs/Plan_m0.8.md; study data in docs/grouping-study/).
 *
 * embed(uri) decodes a MediaStore content uri (EXIF orientation applied,
 * long edge capped at DECODE_CAP px), runs the embedder (L2-normalized,
 * float32), and returns per-stage timings plus the vector as base64-encoded
 * little-endian float32 bytes — compact across the bridge; JS decodes with
 * Float32Array when it needs the values.
 */
private const val MODEL_ASSET = "mobilenet_v3_large.tflite"
private const val DECODE_CAP = 1024

class ImageEmbedderModule : Module() {
  private var embedder: ImageEmbedder? = null

  private fun requireEmbedder(): ImageEmbedder {
    embedder?.let { return it }
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val options = ImageEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL_ASSET).build())
      .setL2Normalize(true)
      .setQuantize(false)
      .build()
    return ImageEmbedder.createFromOptions(context, options).also { embedder = it }
  }

  private fun decode(uriString: String): Bitmap {
    val context = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "no react context", null)
    val uri = Uri.parse(uriString)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val source = ImageDecoder.createSource(context.contentResolver, uri)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val long = maxOf(info.size.width, info.size.height)
        // ceil so the decoded long edge never exceeds DECODE_CAP
        if (long > DECODE_CAP) decoder.setTargetSampleSize((long + DECODE_CAP - 1) / DECODE_CAP)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    // API < 28 fallback: no EXIF handling (benchmark devices are 31+)
    context.contentResolver.openInputStream(uri).use { stream ->
      return BitmapFactory.decodeStream(stream)
        ?: throw CodedException("DECODE_FAILED", uriString, null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ImageEmbedder")

    AsyncFunction("embed") { uriString: String ->
      val t0 = SystemClock.elapsedRealtime()
      val bitmap = decode(uriString)
      val t1 = SystemClock.elapsedRealtime()
      val result = requireEmbedder().embed(BitmapImageBuilder(bitmap).build())
      val t2 = SystemClock.elapsedRealtime()
      val vec = result.embeddingResult().embeddings()[0].floatEmbedding()
      val bytes = ByteBuffer.allocate(vec.size * 4).order(ByteOrder.LITTLE_ENDIAN)
      for (v in vec) bytes.putFloat(v)
      mapOf(
        "decodeMs" to (t1 - t0).toInt(),
        "inferMs" to (t2 - t1).toInt(),
        "dim" to vec.size,
        "vecB64" to Base64.encodeToString(bytes.array(), Base64.NO_WRAP),
      )
    }
  }
}
