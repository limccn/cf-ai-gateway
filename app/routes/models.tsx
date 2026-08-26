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

const createModelSchema = z.object({
  model: z.string().min(1, "Model name is required").max(200, "Max 200 characters"),
  inputPrice: z.coerce.number("Enter a number").min(0, "Must be 0 or greater"),
  outputPrice: z.coerce.number("Enter a number").min(0, "Must be 0 or greater"),
});

const updateModelSchema = z
  .object({
    inputPrice: z.coerce.number("Enter a number").min(0, "Must be 0 or greater").optional(),
    outputPrice: z.coerce.number("Enter a number").min(0, "Must be 0 or greater").optional(),
  })
  .refine((v) => v.inputPrice !== undefined || v.outputPrice !== undefined, {
    message: "Change at least one price",
  });

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
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setModel(editing?.model ?? "");
      setInputPrice(editing ? String(editing.inputPrice) : "");
      setOutputPrice(editing ? String(editing.outputPrice) : "");
      setErrors({});
    }
  }

  const isBusy = createModel.isPending || updateModel.isPending;
  const mutationError = createModel.error?.message ?? updateModel.error?.message;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    if (editing) {
      const parsed = updateModelSchema.safeParse({
        inputPrice: inputPrice.length > 0 ? inputPrice : undefined,
        outputPrice: outputPrice.length > 0 ? outputPrice : undefined,
      });
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
      const parsed = createModelSchema.safeParse({ model, inputPrice, outputPrice });
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
      description="Prices are in USD per 1,000,000 tokens; 0 means free."
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
              placeholder="gpt-4o"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-invalid={errors.model !== undefined}
            />
            {errors.model ? <p className="text-xs text-destructive">{errors.model}</p> : null}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="model-input">Input price / 1M tokens</Label>
            <Input
              id="model-input"
              type="number"
              step="any"
              min={0}
              placeholder="2.50"
              value={inputPrice}
              onChange={(e) => setInputPrice(e.target.value)}
              aria-invalid={errors.inputPrice !== undefined}
            />
            {errors.inputPrice ? (
              <p className="text-xs text-destructive">{errors.inputPrice}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="model-output">Output price / 1M tokens</Label>
            <Input
              id="model-output"
              type="number"
              step="any"
              min={0}
              placeholder="10.00"
              value={outputPrice}
              onChange={(e) => setOutputPrice(e.target.value)}
              aria-invalid={errors.outputPrice !== undefined}
            />
            {errors.outputPrice ? (
              <p className="text-xs text-destructive">{errors.outputPrice}</p>
            ) : null}
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
                <TableHead className="text-right">Input / 1M tokens</TableHead>
                <TableHead className="text-right">Output / 1M tokens</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.model}</TableCell>
                  <TableCell className="text-right">{formatUsd(item.inputPrice)}</TableCell>
                  <TableCell className="text-right">{formatUsd(item.outputPrice)}</TableCell>
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
            Delete the price entry for <strong>{deleting?.model}</strong>? Requests to this model
            will be rejected.
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
