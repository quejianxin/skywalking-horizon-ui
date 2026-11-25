<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff, describeApiError } from '@/api/client';
import type { AiAdminSettings } from '@/api/scopes/admin-ai-settings';
import { useAuthStore } from '@/state/auth';
import { refreshAiConfig } from '@/ai/useAiChat';

const auth = useAuthStore();

const { t } = useI18n();

const loaded = ref<AiAdminSettings | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const flash = ref<string | null>(null);
const clearKey = ref(false);

const draft = reactive({
  enabled: false,
  provider: 'openai-compatible' as AiAdminSettings['provider'],
  model: '',
  baseUrl: '',
  region: '',
  apiKey: '',
});

function apply(view: AiAdminSettings): void {
  loaded.value = view;
  draft.enabled = view.enabled;
  draft.provider = view.provider;
  draft.model = view.model;
  draft.baseUrl = view.baseUrl;
  draft.region = view.region;
  draft.apiKey = '';
  clearKey.value = false;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    apply(await bff.adminAiSettings.get());
    loadError.value = null;
  } catch (err) {
    loadError.value = describeApiError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

const readOnly = computed(() => loaded.value !== null && (!loaded.value.writable || !auth.hasVerb('ai-settings:write')));

const sourceLabel = computed(() => {
  const source = loaded.value?.source;
  if (source === 'settings-file') return t('Saved in this page');
  if (source === 'unset') return t('Not saved yet');
  return t('From environment variables');
});

const dirty = computed(() => {
  const view = loaded.value;
  if (!view) return false;
  return (
    draft.enabled !== view.enabled ||
    draft.provider !== view.provider ||
    draft.model.trim() !== view.model ||
    draft.baseUrl.trim() !== view.baseUrl ||
    draft.region.trim() !== view.region ||
    draft.apiKey !== '' ||
    clearKey.value
  );
});

const keyHint = computed(() =>
  loaded.value?.hasApiKey
    ? t('Leave blank to keep the existing key only if provider, base URL and region are unchanged.')
    : t('No API key configured.'),
);

const missingBaseUrl = computed(
  () => draft.enabled && draft.provider === 'openai-compatible' && draft.baseUrl.trim() === '',
);
const modelPlaceholder = computed(() =>
  draft.provider === 'anthropic'
    ? t('e.g. claude-sonnet-4-5')
    : t('e.g. deepseek-chat or a Bedrock inference-profile id'),
);
const baseUrlPlaceholder = computed(() =>
  draft.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
);
// 名单来自部署方环境变量，保存时服务端会再校验一次；这里提前展示，避免填完才报错。
const approvedBaseUrlHint = computed(() => {
  const approved = loaded.value?.approvedBaseUrls ?? [];
  return approved.length === 0
    ? t('This deployment has not approved any model endpoint, so saving fails. Ask the deployment owner to add one to HORIZON_AI_ALLOWED_BASE_URLS.')
    : t('Approved endpoints: {urls}', { urls: approved.join(', ') });
});
const approvedRegionHint = computed(() => {
  const approved = loaded.value?.approvedRegions ?? [];
  return approved.length === 0
    ? t('This deployment has not approved any Bedrock region.')
    : t('Approved regions: {regions}', { regions: approved.join(', ') });
});
const missingModel = computed(() => draft.enabled && draft.model.trim() === '');
const canSave = computed(
  () => !readOnly.value && !saving.value && dirty.value && !missingBaseUrl.value && !missingModel.value,
);

async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  saveError.value = null;
  flash.value = null;
  try {
    const apiKey = clearKey.value ? '' : draft.apiKey !== '' ? draft.apiKey : undefined;
    const view = await bff.adminAiSettings.save({
      enabled: draft.enabled,
      provider: draft.provider,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      region: draft.region.trim(),
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    apply(view);
    const refreshed = await refreshAiConfig();
    flash.value = refreshed ? t('Saved.') : t('Saved, but the assistant status could not be refreshed. Reopen the assistant to retry.');
  } catch (err) {
    saveError.value = describeApiError(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="ai">
    <header class="ai__head">
      <div class="ai__kicker">{{ t('Admin') }}</div>
      <h1>{{ t('AI assistant') }}</h1>
      <p class="ai__lede">
        {{ t('Configure the model provider used by the AI assistant. Changes take effect immediately and are kept across restarts.') }}
      </p>
    </header>

    <div v-if="loading" class="ai__empty">{{ t('Loading…') }}</div>
    <div v-else-if="loadError" class="ai__error">{{ t('Failed to load: {err}', { err: loadError }) }}</div>
    <template v-else-if="loaded">
      <div v-if="!loaded.writable" class="ai__notice">
        {{ t('Settings are read-only: this deployment configures the AI assistant through environment variables.') }}
      </div>
      <div v-else-if="!auth.hasVerb('ai-settings:write')" class="ai__notice">{{ t('read-only') }}</div>

      <section class="ai__card">
        <div class="ai__status">
          <span class="ai__pill" :class="loaded.enabled ? 'is-on' : 'is-off'">
            {{ loaded.enabled ? t('Enabled') : t('Disabled') }}
          </span>
          <span class="ai__pill" :class="loaded.ready ? 'is-ok' : 'is-warn'">
            {{ loaded.ready ? t('Ready') : t('Not ready') }}
          </span>
          <span class="ai__source">{{ sourceLabel }}</span>
        </div>

        <label class="ai__row ai__row--check">
          <input v-model="draft.enabled" type="checkbox" :disabled="readOnly || saving" />
          <span>{{ t('Enable the AI assistant') }}</span>
        </label>

        <label class="ai__row">
          <span class="ai__label">{{ t('Provider') }}</span>
          <select v-model="draft.provider" class="ai__input" :disabled="readOnly || saving">
            <option value="openai-compatible">openai-compatible</option>
            <option value="bedrock">bedrock</option>
            <option value="anthropic">anthropic</option>
          </select>
          <span class="ai__hint">
            {{ t('openai-compatible covers OpenAI, DeepSeek, local models and gateways. Choose bedrock for Amazon Bedrock or anthropic for the Claude API.') }}
          </span>
        </label>

        <label class="ai__row">
          <span class="ai__label">{{ t('Model') }}</span>
          <input
            v-model="draft.model"
            class="ai__input"
            type="text"
            autocomplete="off"
            :disabled="readOnly || saving"
            :placeholder="modelPlaceholder"
          />
          <span v-if="missingModel" class="ai__hint ai__hint--err">{{ t('A model id is required when the assistant is enabled.') }}</span>
        </label>

        <label v-if="draft.provider !== 'bedrock'" class="ai__row">
          <span class="ai__label">{{ t('Base URL') }}</span>
          <input
            v-model="draft.baseUrl"
            class="ai__input"
            type="url"
            autocomplete="off"
            :disabled="readOnly || saving"
            :placeholder="baseUrlPlaceholder"
          />
          <span v-if="missingBaseUrl" class="ai__hint ai__hint--err">{{ t('Base URL is required for the openai-compatible provider.') }}</span>
          <span v-else-if="draft.provider === 'anthropic'" class="ai__hint">{{ t('Leave blank to call the official Anthropic API. Enter a base URL only for an approved gateway.') }}</span>
          <span v-else class="ai__hint">{{ approvedBaseUrlHint }}</span>
        </label>

        <label v-if="draft.provider === 'bedrock'" class="ai__row">
          <span class="ai__label">{{ t('Region') }}</span>
          <input
            v-model="draft.region"
            class="ai__input"
            type="text"
            autocomplete="off"
            :disabled="readOnly || saving"
            placeholder="us-west-2"
          />
          <span class="ai__hint">{{ t('Leave blank to read the region from AWS_REGION or AWS_DEFAULT_REGION.') }}</span>
          <span class="ai__hint">{{ approvedRegionHint }}</span>
        </label>

        <div class="ai__row">
          <label class="ai__label" for="ai-api-key">{{ t('API key') }}</label>
          <input
            id="ai-api-key"
            v-model="draft.apiKey"
            class="ai__input"
            type="password"
            autocomplete="new-password"
            :disabled="readOnly || saving || clearKey"
            :placeholder="keyHint"
          />
          <span v-if="loaded.hasApiKey" class="ai__hint">{{ keyHint }}</span>
          <span v-if="draft.provider === 'bedrock'" class="ai__hint">{{ t('For Bedrock, use the bearer key (ABSK…).') }}</span>
          <span v-else-if="draft.provider === 'anthropic'" class="ai__hint">{{ t('For Anthropic, use an API key from console.anthropic.com (sk-ant-…).') }}</span>
          <label v-if="loaded.hasApiKey" class="ai__clear">
            <input v-model="clearKey" type="checkbox" :disabled="readOnly || saving" />
            <span>{{ t('Remove the stored API key on save') }}</span>
          </label>
        </div>

        <footer class="ai__actions">
          <button class="ai__btn ai__btn--primary" type="button" :disabled="!canSave" @click="save">
            {{ saving ? t('Saving…') : t('Save') }}
          </button>
          <span v-if="flash" class="ai__flash">{{ flash }}</span>
          <span v-else-if="dirty" class="ai__dirty">{{ t('Unsaved changes') }}</span>
          <span v-else-if="loaded.source === 'settings-file'" class="ai__clean">{{ t('Saved') }}</span>
          <span v-if="saveError" class="ai__error">{{ t('Failed to save: {err}', { err: saveError }) }}</span>
        </footer>
      </section>

      <p class="ai__foot">
        {{ t('The API key is stored on the server and is never shown again. Only users with write permission can change these settings.') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.ai {
  padding: 20px 20px 60px;
  max-width: 860px;
  margin: 0 auto;
  color: var(--sw-fg-1);
}
.ai__head { margin-bottom: 16px; }
.ai__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ai h1 {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.ai__lede {
  margin: 6px 0 0;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-2);
}
.ai__empty { padding: 20px; color: var(--sw-fg-2); }
.ai__notice {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--sw-warn, var(--sw-line-2));
  border-radius: 6px;
  background: var(--sw-warn-soft, var(--sw-bg-2));
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
}
.ai__card {
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  background: var(--sw-bg-1);
  padding: 16px 18px;
}
.ai__status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--sw-line);
  margin-bottom: 4px;
}
.ai__pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--sw-fs-xs);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
}
.ai__pill.is-on { color: var(--sw-accent); border-color: var(--sw-accent); }
.ai__pill.is-ok { color: var(--sw-ok); border-color: var(--sw-ok); }
.ai__pill.is-warn { color: var(--sw-warn, var(--sw-err)); border-color: var(--sw-warn, var(--sw-err)); }
.ai__source { margin-left: auto; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
.ai__row {
  display: grid;
  gap: 4px;
  padding: 12px 0;
  border-bottom: 1px solid var(--sw-line);
}
.ai__row--check {
  grid-auto-flow: column;
  justify-content: start;
  align-items: center;
  gap: 8px;
}
.ai__label { font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: var(--sw-ls-caps); color: var(--sw-fg-3); }
.ai__input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
}
.ai__input:disabled { opacity: 0.6; }
.ai__hint { font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
.ai__hint--err { color: var(--sw-err); }
.ai__clear { display: flex; align-items: center; gap: 6px; font-size: var(--sw-fs-xs); color: var(--sw-fg-2); margin-top: 4px; }
.ai__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 16px;
  flex-wrap: wrap;
}
.ai__btn {
  padding: 6px 14px;
  border-radius: 5px;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
  cursor: pointer;
}
.ai__btn--primary { border-color: var(--sw-accent); color: var(--sw-accent); }
.ai__btn:disabled { opacity: 0.5; cursor: default; }
.ai__flash { color: var(--sw-ok); font-size: var(--sw-fs-base); }
.ai__dirty { color: var(--sw-fg-2); font-size: var(--sw-fs-base); }
.ai__clean { color: var(--sw-fg-3); font-size: var(--sw-fs-base); }
.ai__error { color: var(--sw-err); font-size: var(--sw-fs-base); }
.ai__foot { margin-top: 12px; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); line-height: var(--sw-lh-normal); }
</style>
