import { Want } from '@kit.AbilityKit';
import { FormExtensionAbility, formBindingData, formInfo, formProvider } from '@kit.FormKit';
import { FormStatus } from './FormStatus';

export default class LeoFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    const id = String(want.parameters?.[formInfo.FormParam.IDENTITY_KEY] ?? '');
    try { FormStatus.remember(this.context, id, true); } catch (_error) {}
    return formBindingData.createFormBindingData(FormStatus.read(this.context));
  }

  onUpdateForm(formId: string): void {
    try { FormStatus.remember(this.context, formId, true); } catch (_error) {}
    formProvider.updateForm(formId,
      formBindingData.createFormBindingData(FormStatus.read(this.context))).catch(() => {});
  }

  onRemoveForm(formId: string): void {
    try { FormStatus.remember(this.context, formId, false); } catch (_error) {}
  }
}
