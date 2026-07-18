package expo.modules.mediastoreactions

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.ACTION_INTENT_SENDER_REQUEST
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult.Companion.EXTRA_INTENT_SENDER_REQUEST
import androidx.annotation.RequiresApi
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.providers.AppContextProvider
import java.io.Serializable

enum class MediaStoreAction : Serializable {
  TRASH,
  FAVOURITE,
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

  @RequiresApi(Build.VERSION_CODES.R)
  override fun createIntent(context: Context, input: MediaStoreActionInput): Intent {
    val request = when (input.action) {
      MediaStoreAction.TRASH -> MediaStore.createTrashRequest(contentResolver, input.uris, input.value)
      MediaStoreAction.FAVOURITE -> MediaStore.createFavoriteRequest(contentResolver, input.uris, input.value)
    }
    val sender = IntentSenderRequest.Builder(request.intentSender).build()
    return Intent(ACTION_INTENT_SENDER_REQUEST).putExtra(EXTRA_INTENT_SENDER_REQUEST, sender)
  }

  override fun parseResult(input: MediaStoreActionInput, resultCode: Int, intent: Intent?): Boolean {
    return resultCode == Activity.RESULT_OK
  }
}
