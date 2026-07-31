package expo.modules.mediastoreactions

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.ACTION_INTENT_SENDER_REQUEST
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.EXTRA_INTENT_SENDER_REQUEST
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.providers.AppContextProvider
import java.io.Serializable

enum class MediaStoreAction : Serializable {
  TRASH,
  FAVOURITE,
  WRITE,
}

data class MediaStoreActionInput(
  val uris: List<Uri>,
  val action: MediaStoreAction,
  val value: Boolean,
) : Serializable

class MediaStoreActionContract(
  private val appContextProvider: AppContextProvider,
) : AppContextActivityResultContract<MediaStoreActionInput, Boolean> {
  private val contentResolver: ContentResolver
    get() = appContextProvider.appContext.reactContext?.contentResolver
      ?: throw IllegalStateException("Android content resolver is unavailable")

  override fun createIntent(context: Context, input: MediaStoreActionInput): Intent {
    val request = when (input.action) {
      MediaStoreAction.TRASH -> MediaStore.createTrashRequest(contentResolver, input.uris, input.value)
      MediaStoreAction.FAVOURITE -> MediaStore.createFavoriteRequest(contentResolver, input.uris, input.value)
      // Gate-0 diagnostic (m0.7 item A): ask Android to delegate write access
      // to other apps' media — the documented Android 11+ mechanism when the
      // caller holds broad read but cannot itself grant write.
      MediaStoreAction.WRITE -> MediaStore.createWriteRequest(contentResolver, input.uris)
    }
    val sender = IntentSenderRequest.Builder(request.intentSender).build()
    return Intent(ACTION_INTENT_SENDER_REQUEST).putExtra(EXTRA_INTENT_SENDER_REQUEST, sender)
  }

  override fun parseResult(input: MediaStoreActionInput, resultCode: Int, intent: Intent?): Boolean {
    return resultCode == Activity.RESULT_OK
  }
}
