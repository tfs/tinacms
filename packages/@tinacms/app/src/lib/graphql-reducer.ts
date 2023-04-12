import React from 'react'
import * as G from 'graphql'
import { z, ZodError } from 'zod'
// @ts-expect-error
import schemaJson from 'SCHEMA_IMPORT'
import { expandQuery, isNodeType } from './expand-query'
import {
  Form,
  TinaCMS,
  NAMER,
  TinaSchema,
  useCMS,
  resolveField,
  Collection,
  Template,
  TinaField,
  Client,
  FormOptions,
} from 'tinacms'
import { createForm, createGlobalForm, FormifyCallback } from './build-form'
import type {
  PostMessage,
  Payload,
  SystemInfo,
  Document,
  ResolvedDocument,
} from './types'

const documentSchema = z.object({
  _internalValues: z.record(z.unknown()),
  _internalSys: z.object({
    breadcrumbs: z.array(z.string()),
    basename: z.string(),
    filename: z.string(),
    path: z.string(),
    extension: z.string(),
    relativePath: z.string(),
    title: z.string().optional().nullable(),
    template: z.string(),
    // __typename: z.string(), // This isn't being populated for some reason
    collection: z.object({
      name: z.string(),
      slug: z.string(),
      label: z.string(),
      path: z.string(),
      format: z.string(),
    }),
  }),
})

const astNode = schemaJson as G.DocumentNode
const astNodeWithMeta: G.DocumentNode = {
  ...astNode,
  definitions: astNode.definitions.map((def) => {
    if (def.kind === 'ObjectTypeDefinition') {
      return {
        ...def,
        fields: [
          ...(def.fields || []),
          {
            kind: 'FieldDefinition',
            name: {
              kind: 'Name',
              value: '_metadata',
            },
            arguments: [],
            type: {
              kind: 'NonNullType',
              type: {
                kind: 'NamedType',
                name: {
                  kind: 'Name',
                  value: 'JSON',
                },
              },
            },
          },
        ],
      }
    }
    return def
  }),
}
const schema = G.buildASTSchema(astNode)
const schemaForResolver = G.buildASTSchema(astNodeWithMeta)

export const useGraphQLReducer = (
  iframe: React.MutableRefObject<HTMLIFrameElement>
) => {
  const cms = useCMS()
  const tinaSchema = cms.api.tina.schema as TinaSchema
  const [payloads, setPayloads] = React.useState<Payload[]>([])
  const [operationIndex, setOperationIndex] = React.useState(0)

  const handlePayload = React.useCallback(async (payload) => {
    if (!payload?.query) {
      return
    }
    const { query, variables } = payload

    /**
     * First we grab the query from the payload and expand it so it includes
     * information we'll need. Specifically the _sys and _value info used
     * for building forms
     */
    const documentNode = G.parse(query)
    const expandedDocumentNode = expandQuery({ schema, documentNode })
    const expandedQuery = G.print(expandedDocumentNode)
    const expandedData = await cms.api.tina.request(expandedQuery, {
      variables,
    })

    const expandedDocumentNodeForResolver = expandQuery({
      schema: schemaForResolver,
      documentNode,
    })
    const expandedQueryForResolver = G.print(expandedDocumentNodeForResolver)
    const result = await G.graphql({
      schema: schemaForResolver,
      source: expandedQueryForResolver,
      variableValues: variables,
      rootValue: expandedData,
      fieldResolver: async function (source, args, context, info) {
        const fieldName = info.fieldName
        /**
         * Since the `source` for this resolver is the query that
         * ran before passing it into `useTina`, we need to take aliases
         * into consideration, so if an alias is provided we try to
         * see if that has the value we're looking for. This isn't a perfect
         * solution as the `value` gets overwritten depending on the alias
         * query.
         */
        const aliases: string[] = []
        info.fieldNodes.forEach((fieldNode) => {
          if (fieldNode.alias) {
            aliases.push(fieldNode.alias.value)
          }
        })
        let value = source[fieldName] as unknown
        if (!value) {
          aliases.forEach((alias) => {
            const aliasValue = source[alias]
            if (aliasValue) {
              value = aliasValue
            }
          })
        }
        if (fieldName === '_sys') {
          return source._internalSys
        }
        if (fieldName === '_values') {
          return source._internalValues
        }
        if (info.fieldName === '_metadata') {
          if (value) {
            return value
          }
          // TODO: ensure all fields that have _metadata
          // actually need it
          return {
            id: null,
            fields: [],
          }
        }
        if (isNodeType(info.returnType)) {
          let doc: Document
          if (typeof value === 'string') {
            const response = await getDocument(value, cms.api.tina)
            doc = {
              _sys: response._sys,
              _values: response._values,
            }
          } else {
            const { _internalSys, _internalValues } =
              documentSchema.parse(value)
            const _sys = _internalSys as SystemInfo
            const _values = _internalValues as Record<string, unknown>
            doc = {
              _values,
              _sys,
            }
          }
          const collection = tinaSchema.getCollectionByFullPath(doc._sys.path)
          if (!collection) {
            throw new Error(
              `Unable to determine collection for path ${doc._sys.path}`
            )
          }
          const template = tinaSchema.getTemplateForData({
            data: doc._values,
            collection,
          })
          const existingForm = cms.forms.find(doc._sys.path)
          let form: Form | undefined
          let shouldRegisterForm = true
          if (!existingForm) {
            const formConfig: FormOptions<any> = {
              id: doc._sys.path,
              initialValues: doc._values,
              fields: template.fields.map((field) =>
                resolveField(field, tinaSchema)
              ),
              onSubmit: (payload) =>
                onSubmit(collection, doc._sys.relativePath, payload, cms),
              label: collection.label || collection.name,
              queries: [payload.id],
            }
            if (tinaSchema.config.config?.formifyCallback) {
              const callback = tinaSchema.config.config
                ?.formifyCallback as FormifyCallback
              form =
                callback(
                  {
                    createForm: createForm,
                    createGlobalForm: createGlobalForm,
                    skip: () => {},
                    formConfig,
                  },
                  cms
                ) || undefined
              if (!form) {
                // If the form isn't created from formify, we still
                // need it, just don't show it to the user.
                shouldRegisterForm = false
                form = new Form(formConfig)
              }
            } else {
              form = new Form(formConfig)
            }
            if (form) {
              if (shouldRegisterForm) {
                form.subscribe(
                  () => {
                    setOperationIndex((index) => index + 1)
                  },
                  { values: true }
                )
                cms.forms.add(form)
              }
            }
          } else {
            form = existingForm
            form.addQuery(payload.id)
          }
          if (!form) {
            throw new Error(`No form registered for ${doc._sys.path}.`)
          }
          return resolveDocument(doc, template, form)
        }
        return value
      },
    })
    if (result.errors) {
      cms.alerts.error('There was a problem building forms for your query')
      result.errors.forEach((error) => {
        if (error instanceof ZodError) {
          console.log(error.format())
        } else {
          console.error(error)
        }
      })
    } else {
      iframe.current?.contentWindow?.postMessage({
        type: 'updateData',
        id: payload.id,
        data: result.data,
      })
    }
  }, [])

  React.useEffect(() => {
    payloads.forEach((payload) => {
      handlePayload(payload)
    })
  }, [payloads.map(({ id }) => id).join('.'), operationIndex])

  const notifyEditMode = React.useCallback(
    (event: MessageEvent<PostMessage>) => {
      if (event?.data?.type === 'isEditMode') {
        iframe?.current?.contentWindow?.postMessage({
          type: 'tina:editMode',
        })
      }
    },
    []
  )
  const handleOpenClose = React.useCallback(
    (event: MessageEvent<PostMessage>) => {
      if (event.data.type === 'close') {
        const payloadSchema = z.object({ id: z.string() })
        const { id } = payloadSchema.parse(event.data)
        setPayloads((previous) =>
          previous.filter((payload) => payload.id !== id)
        )
        cms.forms.all().map((form) => {
          form.removeQuery(id)
        })
        cms.removeOrphanedForms()
      }
      if (event.data.type === 'open') {
        const payloadSchema = z.object({
          id: z.string(),
          query: z.string(),
          variables: z.record(z.unknown()),
          data: z.record(z.unknown()),
        })
        const payload = payloadSchema.parse(event.data)
        setPayloads((payloads) => [
          ...payloads.filter(({ id }) => id !== payload.id),
          payload,
        ])
        setOperationIndex((index) => index + 1)
      }
    },
    [, cms]
  )

  React.useEffect(() => {
    if (iframe) {
      window.addEventListener('message', handleOpenClose)
      window.addEventListener('message', notifyEditMode)
    }

    return () => {
      window.removeEventListener('message', handleOpenClose)
      window.removeEventListener('message', notifyEditMode)
      cms.removeAllForms()
    }
  }, [iframe.current])

  return { state: {} }
}

const onSubmit = async (
  collection: Collection<true>,
  relativePath: string,
  payload: Record<string, unknown>,
  cms: TinaCMS
) => {
  const tinaSchema = cms.api.tina.schema
  try {
    const mutationString = `#graphql
      mutation UpdateDocument($collection: String!, $relativePath: String!, $params: DocumentUpdateMutation!) {
        updateDocument(collection: $collection, relativePath: $relativePath, params: $params) {
          __typename
        }
      }
    `

    await cms.api.tina.request(mutationString, {
      variables: {
        collection: collection.name,
        relativePath: relativePath,
        params: tinaSchema.transformPayload(collection.name, payload),
      },
    })
    cms.alerts.success('Document saved!')
  } catch (e) {
    cms.alerts.error('There was a problem saving your document')
    console.error(e)
  }
}

type Path = (string | number)[]

const resolveDocument = (
  doc: Document,
  template: Template<true>,
  form: Form
): ResolvedDocument => {
  // @ts-ignore AnyField and TinaField don't mix
  const fields = form.fields as TinaField<true>[]
  const path: Path = []
  const formValues = resolveFormValue({
    fields: fields,
    values: form.values,
    path,
    id: doc._sys.path,
  })
  const metadataFields: Record<string, string> = {}
  Object.keys(formValues).forEach((key) => {
    metadataFields[key] = [...path, key].join('.')
  })

  return {
    ...formValues,
    id: doc._sys.path,
    sys: doc._sys,
    values: form.values,
    _metadata: {
      id: doc._sys.path,
      fields: metadataFields,
    },
    _internalSys: doc._sys,
    _internalValues: doc._values,
    __typename: NAMER.dataTypeName(template.namespace),
  }
}

const resolveFormValue = <T extends Record<string, unknown>>({
  fields,
  values,
  path,
  id,
}: // tinaSchema,
{
  fields: TinaField<true>[]
  values: T
  path: Path
  id: string
  // tinaSchema: TinaSchema
}): T & { __typename?: string } => {
  const accum: Record<string, unknown> = {}
  fields.forEach((field) => {
    const v = values[field.name]
    if (typeof v === 'undefined') {
      return
    }
    if (v === null) {
      return
    }
    accum[field.name] = resolveFieldValue({
      field,
      value: v,
      path,
      id,
    })
  })
  return accum as T & { __typename?: string }
}
const resolveFieldValue = ({
  field,
  value,
  path,
  id,
}: {
  field: TinaField<true>
  value: unknown
  path: Path
  id: string
}) => {
  switch (field.type) {
    case 'object': {
      if (field.templates) {
        if (field.list) {
          if (Array.isArray(value)) {
            return value.map((item, index) => {
              const template = field.templates[item._template]
              if (typeof template === 'string') {
                throw new Error('Global templates not supported')
              }
              const nextPath = [...path, field.name, index]
              const metadataFields: Record<string, string> = {}
              template.fields.forEach((field) => {
                metadataFields[field.name] = [...nextPath, field.name].join('.')
              })
              return {
                __typename: NAMER.dataTypeName(template.namespace),
                _metadata: {
                  id,
                  fields: metadataFields,
                },
                ...resolveFormValue({
                  fields: template.fields,
                  values: item,
                  path: nextPath,
                  id,
                }),
              }
            })
          }
        } else {
          // not implemented
        }
      }

      const templateFields = field.fields
      if (typeof templateFields === 'string') {
        throw new Error('Global templates not supported')
      }
      if (!templateFields) {
        throw new Error(`Expected to find sub-fields on field ${field.name}`)
      }
      if (field.list) {
        if (Array.isArray(value)) {
          return value.map((item, index) => {
            const nextPath = [...path, field.name, index]
            const metadataFields: Record<string, string> = {}
            templateFields.forEach((field) => {
              metadataFields[field.name] = [...nextPath, field.name].join('.')
            })
            return {
              __typename: NAMER.dataTypeName(field.namespace),
              _metadata: {
                id,
                fields: metadataFields,
              },
              ...resolveFormValue({
                fields: templateFields,
                values: item,
                path,
                id,
              }),
            }
          })
        }
      } else {
        const nextPath = [...path, field.name]
        const metadataFields: Record<string, string> = {}
        templateFields.forEach((field) => {
          metadataFields[field.name] = [...nextPath, field.name].join('.')
        })
        return {
          __typename: NAMER.dataTypeName(field.namespace),
          _metadata: {
            id,
            fields: metadataFields,
          },
          ...resolveFormValue({
            fields: templateFields,
            values: value as any,
            path,
            id,
          }),
        }
      }
    }
    default: {
      return value
    }
  }
}

const getDocument = async (id: string, tina: Client) => {
  const response = await tina.request<{
    node: { _sys: SystemInfo; _values: Record<string, unknown> }
  }>(
    `query GetNode($id: String!) {
node(id: $id) {
...on Document {
_values
_sys {
  breadcrumbs
  basename
  filename
  path
  extension
  relativePath
  title
  template
  collection {
    name
    slug
    label
    path
    format
    matches
    templates
    fields
    __typename
  }
  __typename
}
}
}
}`,
    { variables: { id: id } }
  )
  return response.node
}
