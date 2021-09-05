import {
    CreateManyDto,
    CrudRequest,
    CrudRequestOptions,
    CrudService,
    GetManyDefaultResponse,
    JoinOptions,
    QueryOptions,
} from '@mfcsafe/crud';
import {
    ParsedRequestParams,
    QueryFields,
    QueryFilter,
    QueryJoin,
    QuerySort,
} from '@mfcsafe/crud-request';
import {
    DeepPartial,
    hasLength,
    isArrayFull,
    isNil,
    isObject,
    isObjectFull,
    isUndefined,
    objKeys,
} from '@mfcsafe/util';
import { ObjectId } from 'mongodb';
import { Document, Query, Model, Schema, EnforceDocument, FilterQuery } from 'mongoose';

import { MONGOOSE_OPERATOR_MAP } from './mongoose-operator-map';

/**
 * Required so that ObjectIds are serialized correctly
 * See: http://thecodebarbarian.com/whats-new-in-mongoose-54-global-schematype-configuration.html#schematype-getters
 */
// tslint:disable-next-line:no-var-requires
const mongoose = require('mongoose');
mongoose.ObjectId.get((v) => (v ? v.toString() : null));

export class MongooseCrudService<T extends Document> extends CrudService<T> {
    protected entityColumns: string[] = [];
    protected entityPrimaryColumns: string[] = [];

    constructor(
        public repo: Model<T>
    ) {
        super();

        this.onInitMapEntityColumns();
        this.onInitMapRelations();
    }

    public get findOne(): Model<T>['findOne'] {
        return this.repo.findOne.bind(this.repo);
    }

    public get find(): Model<T>['find'] {
        return this.repo.find.bind(this.repo);
    }

    public get findById(): Model<T>['findById'] {
        return this.repo.findById.bind(this.repo);
    }

    public get count(): Model<T>['count'] {
        return this.repo.countDocuments.bind(this.repo);
    }

    protected get alias(): string {
        return this.repo.baseModelName;
    }

    public async getMany(req: CrudRequest): Promise<GetManyDefaultResponse<T> | T[]> {
        const { parsed, options } = req;

        const { builder, take, skip } = await this.createBuilder<T[]>(
            this.find,
            parsed,
            options,
        );

        if (this.decidePagination(parsed, options)) {
            const data = await builder;
            const total = await this.count({});

            return this.createPageInfo(data, total, take, skip);
        }

        return builder;
    }

    public async getOne(req: CrudRequest): Promise<T> {
        return this.getOneOrFail(req);
    }

    public async createOne(req: CrudRequest, dto: any): Promise<T> {
        const entity = this.prepareEntityBeforeSave(dto, req.parsed);

        if (!entity) this.throwBadRequestException(`Empty data. Nothing to save.`);

        return this.repo.create(entity);
    }

    public async createMany(
        req: CrudRequest,
        dto: CreateManyDto<DeepPartial<T>>,
    ): Promise<T[]> {
        if (!isObject(dto) || !isArrayFull(dto.bulk)) this.throwBadRequestException(`Empty data. Nothing to save.`);

        const bulk = dto.bulk
            .map((one) => this.prepareEntityBeforeSave(one, req.parsed))
            .filter((d) => !isUndefined(d));

        if (!hasLength(bulk)) this.throwBadRequestException(`Empty data. Nothing to save.`);

        return ((await this.repo.create(bulk)) as unknown) as T[];
    }

    public async updateOne(req: CrudRequest, dto: any): Promise<T> {
        const { allowParamsOverride, returnShallow } = req.options.routes.updateOneBase;
        const paramsFilters = this.getParamFilters(req.parsed);
        const authPersist = req.parsed.authPersist || {};
        const toFind = { ...paramsFilters };

        const found = returnShallow
            ? await this.getOneShallowOrFail(toFind)
            : await this.getOneOrFail(req);

        const toSave = !allowParamsOverride
            ? { ...found.toObject(), ...dto, ...paramsFilters, ...authPersist }
            : { ...found.toObject(), ...dto, ...authPersist };

        const updated = await this.repo.findOneAndUpdate({ _id: found._id }, toSave, { new: true });

        if (returnShallow) return updated;

        req.parsed.paramsFilter.forEach((filter) => {
            filter.value = updated[filter.field];
        });

        return this.getOneOrFail(req);
    }

    public async replaceOne(req: CrudRequest, dto: DeepPartial<T> | any): Promise<T> {
        const { allowParamsOverride, returnShallow } = req.options.routes.replaceOneBase;

        const paramsFilters = this.getParamFilters(req.parsed);
        const authPersist = req.parsed.authPersist || {};

        const found = await (returnShallow ? this.getOneShallowOrFail({ ...paramsFilters }) : this.getOneOrFail(req));

        const toSave = !allowParamsOverride
            ? { ...dto, ...paramsFilters, ...authPersist }
            : { ...paramsFilters, ...dto, ...authPersist };

        await this.repo.replaceOne({ _id: found._id }, toSave);

        return this.findById(found._id);
    }

    public async deleteOne(req: CrudRequest): Promise<void | T> {
        const { returnDeleted } = req.options.routes.deleteOneBase;

        const paramsFilters = this.getParamFilters(req.parsed);

        const found = await this.getOneShallowOrFail({ ...paramsFilters });
        const deleted = await this.repo.findOneAndDelete({ _id: found._id });

        return returnDeleted ? { ...deleted, ...paramsFilters } : undefined;
    }

    public getParamFilters(parsed: CrudRequest['parsed']): FilterQuery<T> {
        if (!hasLength(parsed.paramsFilter)) return {};

        return parsed.paramsFilter.reduce((acc, item) => ({ ...acc, [item.field]: item.value }), {});
    }

    public decidePagination(
        parsed: ParsedRequestParams,
        options: CrudRequestOptions,
    ): boolean {
        return (
            (Number.isFinite(parsed.page) || Number.isFinite(parsed.offset)) && !!this.getTake(parsed, options.query)
        );
    }

    public async createBuilder<K>(
        fn: (...args) => Query<K, EnforceDocument<T, {}>, {}, T>,
        parsed: ParsedRequestParams,
        options: CrudRequestOptions,
        many = true,
    ): Promise<{
        builder: Query<K, EnforceDocument<T, {}>, {}, T>;
        take?: number;
        skip?: number;
        search: any;
    }> {
        const search = this.getDefaultSearchCondition(options, parsed);

        const builder = fn(search);

        builder.select(this.getSelect(parsed, options.query));

        const joinOptions = options.query.join || {};
        const allowedJoins = objKeys(joinOptions);

        if (hasLength(allowedJoins)) {
            const eagerJoins: { [key: string]: boolean } = {};

            for (let i = 0; i < allowedJoins.length; i++) {
                if (!joinOptions[allowedJoins[i]].eager) continue;

                const cond = parsed.join.find((j) => j && j.field === allowedJoins[i]) || { field: allowedJoins[i] };

                this.setJoin(cond, joinOptions, builder);

                builder.populate(cond.field, cond.select.join(' '));

                eagerJoins[allowedJoins[i]] = true;
            }

            if (isArrayFull(parsed.join)) {
                for (let i = 0; i < parsed.join.length; i++) {
                    if (!eagerJoins[parsed.join[i].field]) this.setJoin(parsed.join[i], joinOptions, builder);
                }
            }
        }

        if (!many) return { builder, search };

        builder.sort(this.getSort(parsed, options.query));

        const take = this.getTake(parsed, options.query);
        const skip = this.getSkip(parsed, take);

        if (isFinite(take)) builder.limit(take);
        if (isFinite(skip)) builder.skip(skip);

        return { builder, take, skip, search };
    }

    buildFieldSelect(include: QueryFields, excludes: QueryFields): string {
        return (include || [])
            .filter((field) => !(excludes || []).includes(field))
            .concat(...(excludes || []).map((e) => `-${e}`))
            .join(' ');
    }

    buildNestedVirtualPopulate<K>(field: string, select: string): any {
        const fields = field.split('.');
        const populates = [];

        let lastSchema: Schema = this.repo.schema;

        for (let i = 0; i < fields.length; ++i) {
            const virtual: any = lastSchema.virtualpath(fields[i]);

            if (virtual) {
                lastSchema = mongoose.model(virtual.options.ref).schema;

                populates.push({ path: fields[i], });
            } else {
                this.throwBadRequestException(`${fields[i]} is not a valid join.`);
            }
        }

        return populates.reverse().reduce(
            (populate, cur, index: number) => ({
                ...cur,
                ...(index === 0 ? { select } : { populate }),
            }), {}
        );
    }

    protected setJoin<K>(
        cond: QueryJoin,
        joinOptions: JoinOptions,
        builder: Query<K, EnforceDocument<T, {}>, {}, T>,
    ) {
        const joinOption = joinOptions[cond.field];

        let excludes = isNil(joinOption) ? [] : joinOption.exclude;

        if (isNil(excludes)) excludes = [];

        return builder.populate(
            this.buildNestedVirtualPopulate(
                cond.field,
                this.buildFieldSelect(cond.select, excludes)
            )
        );
    }

    protected async getOneOrFail({ parsed, options }: CrudRequest): Promise<T> {
        const { builder } = await this.createBuilder(this.findOne, parsed, options);

        const found = await builder;

        if (!found) this.throwNotFoundException(this.alias);

        return found;
    }

    protected async getOneShallowOrFail(where: FilterQuery<T>): Promise<T> {
        const found = await (where._id ? this.findById(where._id) : this.findOne(where));

        if (!found) this.throwNotFoundException(this.alias);

        return found;
    }

    protected prepareEntityBeforeSave(
        dto: DeepPartial<T>,
        parsed: CrudRequest['parsed'],
    ): DeepPartial<T> {
        if (!isObject(dto)) return undefined;

        if (hasLength(parsed.paramsFilter)) {
            for (const filter of parsed.paramsFilter) dto[filter.field] = filter.value;
        }

        const authPersist = isObject(parsed.authPersist) ? parsed.authPersist : {};

        if (!hasLength(objKeys(dto))) return undefined;

        return { ...dto, ...authPersist };
    }

    protected getDefaultSearchCondition(
        options: CrudRequestOptions,
        parsed: ParsedRequestParams,
    ): any {
        return {
            ...Object.entries(parsed.search)
                .filter(([, value]) => !Array.isArray(value) || value.length > 0)
                .reduce((prev, [key, value]) => ({ ...prev, [key]: value, }), {},),
            ...this.queryFilterToSearch(parsed.paramsFilter)
        };
    }

    protected queryFilterToSearch(filter: any): any {
        if (isArrayFull(filter)) {
            return filter
                .filter((item) => !!MONGOOSE_OPERATOR_MAP[item.operator])
                .reduce((prev, item) => {
                    const operators: QueryFilter[] = MONGOOSE_OPERATOR_MAP[item.operator].call(this, item.value,);

                    return {
                        ...prev,
                        [item.field]: operators.reduce(
                            (query, cur) => ({
                                ...query,
                                [cur.operator]: item.field === '_id' ? new ObjectId(cur.value) : cur.value,
                            }), {},
                        ),
                    };
                }, {});
        }

        if (isObject(filter)) {
            return Object.keys(filter).reduce((prev, key) => {
                const conditions = isArrayFull(filter[key])
                    ? filter[key].filter((condition) => !!condition && isObjectFull(condition))
                    : [];

                return { ...prev, ...(conditions.length > 0 ? { [key]: conditions } : {}), };
            }, {});
        }

        return { };
    }

    protected onInitMapEntityColumns() {
        this.repo.schema.eachPath((path) => {
            this.entityColumns.push(path);
        });
    }

    protected onInitMapRelations() {
        // this.entityRelationsHash = this.repo.metadata.relations.reduce(
        //   (hash, curr) => ({
        //     ...hash,
        //     [curr.propertyName]: {
        //       name: curr.propertyName,
        //       columns: curr.inverseEntityMetadata.columns.map((col) => col.propertyName),
        //       primaryColumns: curr.inverseEntityMetadata.primaryColumns.map(
        //         (col) => col.propertyName,
        //       ),
        //     },
        //   }),
        //   {},
        // );
    }

    protected getAllowedColumns(columns: string[], options: QueryOptions): string[] {
        if (!options.exclude?.length && !options.allow?.length) return columns;

        return columns.filter(column =>
            (options.exclude?.length ? !options.exclude.some((col) => col === column) : true) &&
            (options.allow?.length ? options.allow.some((col) => col === column) : true),
        );
    }

    protected getSelect(query: ParsedRequestParams, options: QueryOptions): string {
        const allowed = this.getAllowedColumns(this.entityColumns, options);

        const columns =
            Array.isArray(query.fields) && query.fields.length
                ? query.fields.filter((field) => allowed.some((col) => field === col))
                : allowed;

        return [
            ...(options.persist && options.persist.length ? options.persist : []),
            ...columns,
            ...this.entityPrimaryColumns,
        ].map(col  => `${col}`).join(' ');
    }

    protected getSort(query: ParsedRequestParams, options: QueryOptions) {
        if (query.sort?.length) return this.mapSort(query.sort);
        if (options.sort?.length) return this.mapSort(options.sort);

        return {};
    }

    protected mapSort(sort: QuerySort[]) {
        return sort.reduce((acc, item) => ({ ...acc, [item.field]: item.order.toLowerCase() }), {});
    }
}
