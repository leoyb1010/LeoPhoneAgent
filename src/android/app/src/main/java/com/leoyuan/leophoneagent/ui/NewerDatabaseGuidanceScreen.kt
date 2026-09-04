package com.leoyuan.leophoneagent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.data.db.DatabaseVersionGuard

@Composable
fun NewerDatabaseGuidanceScreen(onExit: () -> Unit) {
    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(stringResource(R.string.newer_db_title), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
                    Text(stringResource(R.string.newer_db_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    Text(stringResource(R.string.newer_db_versions, DatabaseVersionGuard.CODE_DB_VERSION), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = onExit, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.newer_db_exit))
                    }
                }
            }
        }
    }
}
