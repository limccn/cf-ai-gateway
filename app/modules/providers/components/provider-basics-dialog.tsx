// Edit provider — basics 弹窗（批次 N，2026-09-21；PRD N1/N2）。
//
// 只管基础信息五个字段（name / type / baseUrl / apiKey / models）。高级项在
// provider-advanced-dialog.tsx 里另开一窗 —— 拆分的意义是：只想改 baseUrl 的人不该被
// weight / thinking mode / httpOptions JSON 这些字段的当前值围着，也不该因为
// 「没动过的字段会不会被一起提交上去」而犹豫。两个弹窗各提交各的，互不携带对方字段。
//
// API key 的编辑门（PRD N2）：
//   未点 Edit → 渲染**纯文本**掩码（`apiKeyMasked`），DOM 里根本没有 input，
//               密码管理器没有可填的目标，autofill 无从发生。
//   已点 Edit → 渲染空的 `type="password"` + autoComplete="new-password"；
//               Cancel 会**清空已输入的值**再退回只读态 —— 否则用户打了半截又取消，
//               那半截仍留在 state 里，提交时会被当成「用户想改成这个」发出去。
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useUpdateProvider } from "../hooks/use-update-provider";
import { parseBasicsUpdate, providerToForm } from "../form";
import type { FieldErrors, ProviderFormState } from "../form";
import type { ProviderResponse } from "../types";
import { FormError, ProviderBasicsFields } from "./provider-fields";
import type { ApiKeyMode } from "./provider-fields";

export interface ProviderBasicsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 关闭态（open=false）时可为 null；内容只在 open 时挂载，故不读它的空值。 */
  provider: ProviderResponse | null;
}

export function ProviderBasicsDialog({ open, onOpenChange, provider }: ProviderBasicsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Edit basics — ${provider.name}` : "Edit basics"}
      description="Name, endpoint, key and model mapping. Advanced options have their own dialog."
    >
      {open && provider ? (
        <EditBasicsForm provider={provider} onDone={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function EditBasicsForm({ provider, onDone }: { provider: ProviderResponse; onDone: () => void }) {
  const updateProvider = useUpdateProvider();
  const [form, setForm] = useState<ProviderFormState>(() => providerToForm(provider));
  const [errors, setErrors] = useState<FieldErrors>({});
  // 每次打开都是只读态起步 —— 这正是 N2 要的「初始化显示为不可编辑形式」
  const [keyEditing, setKeyEditing] = useState(false);

  const patch = (next: Partial<ProviderFormState>) => setForm((prev) => ({ ...prev, ...next }));
  const isBusy = updateProvider.isPending;

  const apiKeyMode: ApiKeyMode = keyEditing
    ? {
        kind: "editing",
        onCancel: () => {
          patch({ apiKey: "" }); // 丢掉打了一半的值，见文件头
          setKeyEditing(false);
        },
      }
    : {
        kind: "locked",
        masked: provider.apiKeyMasked,
        onEdit: () => setKeyEditing(true),
      };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    // 「留空 = 保持原密钥 / 原映射」的省略逻辑在 parseBasicsUpdate 里（纯函数，可单测）
    const parsed = parseBasicsUpdate(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    try {
      await updateProvider.mutateAsync({ id: provider.id, ...parsed.data });
      onDone();
    } catch {
      // 错误显示在表单顶部
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <FormError message={updateProvider.error?.message} />
      <ProviderBasicsFields
        value={form}
        onChange={patch}
        errors={errors}
        apiKeyMode={apiKeyMode}
        editing
      />
      {errors.root ? <p className="text-xs text-destructive">{errors.root}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone} disabled={isBusy}>
          Cancel
        </Button>
        <Button type="submit" disabled={isBusy}>
          {isBusy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
