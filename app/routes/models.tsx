// /models — 模型价格表管理（M6 6.3，admin）：CRUD 表格。
// 单价单位：USD / 每百万 tokens（与后端 seed.sql 一致）。
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { z } from "zod";
import { useModels } from "@/modules/models/hooks/use-models";
import { useCreateModel } from "@/modules/models/hooks/use-create-model";
import { useUpdateModel } from "@/modules/models/hooks/use-update-model";
import { useDeleteModel } from "@/modules/models/hooks/use-delete-model";
import type { ModelResponse } from "@/modules/models/types";
import { formatDateTime, formatUsd } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState, EmptyState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ============= Zod 表单 Schema =============
// 分层规则（M9）：未缓存输入 > 128K tokens 时输入与输出均取 long 档，否则 short 档；
// 缓存命中输入按 cached 价计。单价单位：USD / 每百万 tokens。

const priceField = z.coerce.number("Enter a number").min(0, "Must be 0 or greater");

const createModelSchema = z.object({
  model: z.string().min(1, "Model name is required").max(200, "Max 200 characters"),
  inputPriceShort: priceField,
  inputPriceLong: priceField,
  inputPriceCached: priceField,
  outputPriceShort: priceField,
  outputPriceLong: priceField,
});

const updateModelSchema = z
  .object({
    inputPriceShort: priceField.optional(),
    inputPriceLong: priceField.optional(),
    inputPriceCached: priceField.optional(),
    outputPriceShort: priceField.optional(),
    outputPriceLong: priceField.optional(),
  })
  .refine(
    (v) =>
      v.inputPriceShort !== undefined ||
      v.inputPriceLong !== undefined ||
      v.inputPriceCached !== undefined ||
      v.outputPriceShort !== undefined ||
      v.outputPriceLong !== undefined,
    { message: "Change at least one price" },
  );

// ============= 子组件：价格表单对话框 =============

interface ModelFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ModelResponse;
}

function ModelFormDialog({ open, onOpenChange, editing }: ModelFormDialogProps) {
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();

  const [model, setModel] = useState("");
  const [inputPriceShort, setInputPriceShort] = useState("");
  const [inputPriceLong, setInputPriceLong] = useState("");
  const [inputPriceCached, setInputPriceCached] = useState("");
  const [outputPriceShort, setOutputPriceShort] = useState("");
  const [outputPriceLong, setOutputPriceLong] = useState("");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setModel(editing?.model ?? "");
      setInputPriceShort(editing ? String(editing.inputPriceShort) : "");
      setInputPriceLong(editing ? String(editing.inputPriceLong) : "");
      setInputPriceCached(editing ? String(editing.inputPriceCached) : "");
      setOutputPriceShort(editing ? String(editing.outputPriceShort) : "");
      setOutputPriceLong(editing ? String(editing.outputPriceLong) : "");
      setErrors({});
    }
  }

  const isBusy = createModel.isPending || updateModel.isPending;
  const mutationError = createModel.error?.message ?? updateModel.error?.message;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    // 空字符串 → undefined：update 视为“该项不改”，create 触发必填错误
    const prices = {
      inputPriceShort: inputPriceShort.length > 0 ? inputPriceShort : undefined,
      inputPriceLong: inputPriceLong.length > 0 ? inputPriceLong : undefined,
      inputPriceCached: inputPriceCached.length > 0 ? inputPriceCached : undefined,
      outputPriceShort: outputPriceShort.length > 0 ? outputPriceShort : undefined,
      outputPriceLong: outputPriceLong.length > 0 ? outputPriceLong : undefined,
    };
    if (editing) {
      const parsed = updateModelSchema.safeParse(prices);
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await updateModel.mutateAsync({ id: editing.id, ...parsed.data });
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    } else {
      const parsed = createModelSchema.safeParse({ model, ...prices });
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await createModel.mutateAsync(parsed.data);
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit prices — ${editing.model}` : "Add model price"}
      description="Prices are in USD per 1,000,000 tokens; 0 means free. Uncached input over 128K tokens bills the long tier (input + output); cached input bills at the cached rate."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {mutationError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {mutationError}
          </p>
        ) : null}
        {editing ? null : (
          <div className="space-y-2">
            <Label htmlFor="model-name">Model name</Label>
            <Input
              id="model-name"
              placeholder="gpt-5.6-sol"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-invalid={errors.model !== undefined}
            />
            {errors.model ? <p className="text-xs text-destructive">{errors.model}</p> : null}
          </div>
        )}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Input — USD per 1M tokens</span>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="model-input-short">Short ≤ 128K</Label>
              <Input
                id="model-input-short"
                type="number"
                step="any"
                min={0}
                placeholder="2.50"
                value={inputPriceShort}
                onChange={(e) => setInputPriceShort(e.target.value)}
                aria-invalid={errors.inputPriceShort !== undefined}
              />
              {errors.inputPriceShort ? (
                <p className="text-xs text-destructive">{errors.inputPriceShort}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-input-long">Long &gt; 128K</Label>
              <Input
                id="model-input-long"
                type="number"
                step="any"
                min={0}
                placeholder="4.00"
                value={inputPriceLong}
                onChange={(e) => setInputPriceLong(e.target.value)}
                aria-invalid={errors.inputPriceLong !== undefined}
              />
              {errors.inputPriceLong ? (
                <p className="text-xs text-destructive">{errors.inputPriceLong}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-input-cached">Cached hit</Label>
              <Input
                id="model-input-cached"
                type="number"
                step="any"
                min={0}
                placeholder="0.25"
                value={inputPriceCached}
                onChange={(e) => setInputPriceCached(e.target.value)}
                aria-invalid={errors.inputPriceCached !== undefined}
              />
              {errors.inputPriceCached ? (
                <p className="text-xs text-destructive">{errors.inputPriceCached}</p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Output — USD per 1M tokens</span>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="model-output-short">Short ≤ 128K</Label>
              <Input
                id="model-output-short"
                type="number"
                step="any"
                min={0}
                placeholder="10.00"
                value={outputPriceShort}
                onChange={(e) => setOutputPriceShort(e.target.value)}
                aria-invalid={errors.outputPriceShort !== undefined}
              />
              {errors.outputPriceShort ? (
                <p className="text-xs text-destructive">{errors.outputPriceShort}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-output-long">Long &gt; 128K</Label>
              <Input
                id="model-output-long"
                type="number"
                step="any"
                min={0}
                placeholder="15.00"
                value={outputPriceLong}
                onChange={(e) => setOutputPriceLong(e.target.value)}
                aria-invalid={errors.outputPriceLong !== undefined}
              />
              {errors.outputPriceLong ? (
                <p className="text-xs text-destructive">{errors.outputPriceLong}</p>
              ) : null}
            </div>
          </div>
        </div>
        {errors.root ? <p className="text-xs text-destructive">{errors.root}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button type="submit" disabled={isBusy}>
            {isBusy ? "Saving…" : editing ? "Save changes" : "Add price"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ============= 页面 =============

export default function ModelsPage() {
  const modelsQuery = useModels();
  const deleteModel = useDeleteModel();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelResponse | null>(null);
  const [deleting, setDeleting] = useState<ModelResponse | null>(null);

  const items = modelsQuery.data?.items ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Model pricing"
        description="Price table used for usage billing (admin)"
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Plus aria-hidden="true" />
            Add price
          </Button>
        }
      />

      {modelsQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : modelsQuery.isError ? (
        <ErrorState message={modelsQuery.error.message} onRetry={() => modelsQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No price entries yet"
          description="Add model prices before usage can be billed."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Input (short → long) / 1M</TableHead>
                <TableHead className="text-right">Input cached / 1M</TableHead>
                <TableHead className="text-right">Output (short → long) / 1M</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.model}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatUsd(item.inputPriceShort)} → {formatUsd(item.inputPriceLong)}
                  </TableCell>
                  <TableCell className="text-right">{formatUsd(item.inputPriceCached)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatUsd(item.outputPriceShort)} → {formatUsd(item.outputPriceLong)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(item.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(item)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(item)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ModelFormDialog
        open={formOpen || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFormOpen(false);
            setEditing(null);
          }
        }}
        editing={editing ?? undefined}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title="Delete price entry"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Delete the price entry for <strong>{deleting?.model}</strong>? Requests to a model
            without a price entry are not billed — usage is recorded with a warning.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteModel.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteModel.isPending}
              onClick={() => {
                if (deleting) {
                  deleteModel.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
                }
              }}
            >
              {deleteModel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </PageContainer>
  );
}
