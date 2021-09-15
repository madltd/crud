import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { isFalse, isFunction, isObject } from '@mfcdev/util';
import { classToPlain, classToPlainFromExist } from 'class-transformer';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { CrudActions } from '../enums';
import { SerializeOptions } from '../interfaces';
import { CrudBaseInterceptor } from './crud-base.interceptor';

const actionToDtoNameMap: {
  [key in CrudActions]: keyof SerializeOptions;
} = {
  [CrudActions.ReadAll]: 'getMany',
  [CrudActions.ReadOne]: 'get',
  [CrudActions.CreateMany]: 'createMany',
  [CrudActions.CreateOne]: 'create',
  [CrudActions.UpdateOne]: 'update',
  [CrudActions.ReplaceOne]: 'replace',
  [CrudActions.DeleteAll]: 'delete',
  [CrudActions.DeleteOne]: 'delete',
};

@Injectable()
export class CrudResponseInterceptor extends CrudBaseInterceptor
  implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.serialize(context, data)));
  }

  protected transform(dto: any, data: any) {
    if (!isObject(data) || isFalse(dto)) {
      return data;
    }

    if (isFunction(data.toObject)) {
      const plain = data.toObject({
        getters: true,
      });

      return dto ? classToPlain(classToPlainFromExist(plain, new dto())) : plain;
    }

    if (!isFunction(dto)) {
      return data.constructor !== Object ? classToPlain(data) : data;
    }

    return data instanceof dto
      ? classToPlain(data)
      : classToPlain(classToPlainFromExist(data, new dto()));
  }
  protected mongooseTransform(val: any, isArray = false) {
    if (isFunction(val.toObject)) return val.toObject({ getters: true });
    if (isArray) return val.map(this.mongooseTransform.bind(this));
    if (val.data) return { ...val, data: val.data.map(this.mongooseTransform.bind(this)) };

    return val;
  }

  protected serialize(context: ExecutionContext, val: any): any {
    const { crudOptions, action } = this.getCrudInfo(context);
    const { serialize } = crudOptions;
    const dto = serialize[actionToDtoNameMap[action]];
    const isArray = Array.isArray(val);

    const data = this.mongooseTransform(val, isArray);
    // const data = isArray ? val.map(this.mongooseTransform.bind(this)) : { ...val, data: val.data.map(this.mongooseTransform.bind(this)) };

    switch (action) {
      case CrudActions.ReadAll:
        return isArray
          ? (data as any[]).map((item) => this.transform(serialize.get, item))
          : this.transform(dto, data);
      case CrudActions.CreateMany:
        return isArray
          ? (data as any[]).map((item) => this.transform(dto, item))
          : this.transform(dto, data);
      default:
        return this.transform(dto, data);
    }
  }
}
