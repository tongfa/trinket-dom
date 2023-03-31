const { $component, $attributeDirective, $mount, $testHarness } = (function() {
    /* finds index of two consecutive characters in string, i.e. `{{` */
    const indexOf2 = (haystack, needle, pos = 0) => {
        while (true) {
            const index = haystack.indexOf(needle, pos);
            if (index === -1) {
                return -1;
            }
            if (haystack[index + 1] === needle) {
                return index;
            }
            pos = index + 2;
        }
    };

    const HTML_TAG_LIST = [
        'BODY', 'DIV', 'TEMPLATE', 'TABLE', 'TR', 'TH', 'TD', 'SPAN', 'TBODY',
    ];

    const components = {};
    const attributeDirectives = [];
    const attributeNodeGeneratingDirectives = [];
    const attributeAppEntryDirectives = [];
    const needingRefresh = [];
    let refreshTask = null;

    const addIdsToTemplate = (templateId) => {
        let idCount = 0;
        const recurse = (element) => {
            const newElementId = templateId + '$' + ++idCount;
            element.id = newElementId;
            for (child of element.children) {
                recurse(child);
            }
        };
        const template = document.getElementById(templateId);
        if (! template) {
            throw new Error(`cannot find template with id: ${templateId}`);
        }
        recurse(template.content);
    };

    const $component = (definition = {}) => {
        const {name, templateId, initializer, data} = definition;
        if (! name) { throw new Error('Component definition must define a name'); };
        if (! templateId) {
            definition.templateId = name;
        }
        if (! initializer) {
            definition.initializer = () => {};
        }
        components[name] = {...definition, $meta: {}};
    };

    const $attributeDirective = ({test, processor, options} = {}) => {
        if (! test) { throw new Error('Attribute directive definition must define a test'); };
        if (! processor) { throw new Error('Attribute directive definition must define a processor'); };
        /* unshift so last one wins when running attributeTest */
        if (options?.generatesNodes) {
            attributeNodeGeneratingDirectives.unshift({test, processor});
        } else {
            attributeDirectives.unshift({test, processor});
        }
        if (options?.appEntry) {
            attributeAppEntryDirectives.unshift({test, processor});
        }
    };

    const findElementsByAttr = (node, attr, attrValue) => {
        const elementList = [];
        if (node?.attributes?.[attr]?.value === attrValue) {
            return [node];
        }
        if (node.tagName === 'TEMPLATE') {
            for (element of findElementsByAttr(node.content, attr, attrValue)) {
                elementList.push(element);
            }
        }
        for (const childNode of node.children) {
            for (element of findElementsByAttr(childNode, attr, attrValue)) {
                elementList.push(element);
            }
        }
        return elementList;
    };

    const executeTasks = () => {
        refreshTask = null;
        for (const {callback} of needingRefresh) {
            callback();
        }
    };

    const scheduleRefresh = (task) => {
        needingRefresh.push(task);
        if (! refreshTask ) {
            refreshTask = setTimeout(executeTasks);
        }
    };
    const flush = (ref) => new Promise(resolve => {
        const instance = null;
        const callback = resolve;
        scheduleRefresh({instance, ref, callback});
    });

    const prepareEvaluate = (instance, extraContext) => {
        const keys = [];
        const values = [];
        for (datumKey in instance.data) {
            keys.push(datumKey);
            const value = instance.data[datumKey];
            values.push( typeof value === 'function' ? value.bind(instance.data) : value);
        }

        for (datumKey in extraContext) {
            keys.push(datumKey);
            const value = extraContext[datumKey];
            values.push(value);
        }

        const refreshByRef = (ref) => {
            scheduleRefresh({callback: () => {
                /* TODO only works for simple cases */
                const templateNode = findElementsByAttr(instance.component.template, '$ref', ref)[0];
                const dirtyElement = findElementsByAttr(instance.element, '$ref', ref)[0];
                while (dirtyElement.lastChild) {
                    dirtyElement.removeChild(dirtyElement.lastChild);
                }
                const childElements = processTemplateElement(instance, templateNode);
                for (child of childElements) {
                    dirtyElement.appendChild(child);
                }
            }});
        };
        keys.push('$refreshByRef');
        values.push(refreshByRef);

        keys.push('$flush');
        values.push(flush);

        return {keys, values};
    };

    const evaluate = (instance, expression, extraContext = {}) => {
        const { keys, values } = prepareEvaluate(instance, extraContext);
        const f = Function(...keys, `"use strict"; return ${expression}`);

        return f(...values);
    };

    const processTextNode = (instance, node, newNode) => {
        let text = '';
        let pos = 0;
        while (true) {
            const leftBraces = indexOf2(node.textContent, '{', pos);
            const rightBraces = indexOf2(node.textContent, '}', pos + 2);
            if (leftBraces !== -1 && rightBraces !== -1) {
                text += node.textContent.substr(pos, leftBraces - pos);
                const expression = node.textContent.substr(leftBraces + 2, rightBraces - leftBraces - 2);
                text += evaluate(instance, expression);
                pos += rightBraces + 2;
            } else {
                text += node.textContent.substr(pos, node.textContent.length - pos);
                newNode.textContent = text;
                break;
            }
        }
        return newNode;
    };

    const processNodeGeneratingDirectives = (instance, newNodes, templateNode, templateNodeChildren) => {
        const { data } = instance;
        for (attribute of templateNode.attributes) {
            for (atrributeDirective of attributeNodeGeneratingDirectives) {
                if (atrributeDirective.test(attribute)) {
                    if ( newNodes.length !== 0 ) {
                        throw new Error('two new node generating directives ran, yikes!');
                    }
                    return atrributeDirective.processor(
                        { evaluate, processTemplateElement },
                        instance, templateNode, templateNodeChildren, newNodes, attribute);
                }
            }
        }
        return true;
    };

    const processRegularDirectives = (instance, directives, newNodes, templateNode, templateNodeChildren) => {
        const { data } = instance;
        let processChildren = true;
        for (attribute of templateNode.attributes) {
            for (atrributeDirective of directives) {
                if (atrributeDirective.test(attribute)) {
                    for (const newNode of newNodes) {
                        const { skipProcessingFurtherChildren } = atrributeDirective.processor(
                            { evaluate, processTemplateElement },
                            instance, templateNode, templateNodeChildren, newNode, attribute);
                        processChildren &&= !skipProcessingFurtherChildren;
                    }
                    break; // ensures each attribute matches only one directive
                }
            }
        }
        return processChildren;
    };

    const processTemplateElement = (instance, templateNode) => {
        const { data } = instance;
        if (templateNode.nodeName === '#text') {
            const newNode = templateNode.cloneNode();
            // newNode.setAttribute('$templateNodeId', newNode.id)
            delete newNode.id;
            return [processTextNode(instance, templateNode, newNode)];
        }

        const templateNodeChildren = templateNode.nodeName === 'TEMPLATE' ? templateNode.content.childNodes : templateNode.childNodes;


        let processChildren = true;
        let newNodes = [];

        /* first execute directives that are capable of generating multiple nodes, $for is the only one at the moment */
        processChildren &&= processNodeGeneratingDirectives(instance, newNodes, templateNode, templateNodeChildren);

        if (newNodes.length === 0) {
            const newNode = templateNode.cloneNode();
            // newNode.setAttribute('$templateNodeId', newNode.id)
            delete newNode.id;
            newNodes.push(newNode);
        }

        processChildren &&= processRegularDirectives(instance, attributeDirectives, newNodes, templateNode, templateNodeChildren);

        if ( processChildren ) {
            for (const newNode of newNodes) {
                for (const childNode of templateNodeChildren) {
                    const newChildren = processTemplateElement(instance, childNode);
                    for (const newChild of newChildren) {
                        newNode.appendChild(newChild);
                    }
                }
            }
        }

        const provisionedNodes = newNodes.map(newNode => HTML_TAG_LIST.includes(newNodes[0].tagName) ? newNode : mount(instance, newNode));

        if (templateNode.nodeName === 'TEMPLATE') {
            const childrenNodes = [];
            for (const node of provisionedNodes) {
                for (const nodeChild of node.childNodes) {
                    childrenNodes.push(nodeChild);
                }
            }
            return childrenNodes;
        }

        return provisionedNodes;
    };

    /* mounts a component */
    const mount = (parentInstance, element) => {
        const component = components[element.localName];
        if (! component) { throw new Error(`Undefined component: ${element.localName}`); }
        const templateNode = document.getElementById(component.templateId);
        if (! templateNode) {
            throw new Error(`cannot find template with id: ${component.templateId}`);
        }
        if (! component.$meta.setIds) {
            component.$meta.setIds = true;
            addIdsToTemplate(component.templateId);
            component.template = templateNode;
        }
        const data = {...parentInstance.data, ...component.data };
        const instance = { component, data, element, $meta: {} };
        const childElements = processTemplateElement(instance, templateNode);
        for (child of childElements) {
            element.appendChild(child);
        }
        return { instance, element, templateNode };
    };

    const testHarness = (element) => {
        const $flush = flush;
        const $findElementsByAttr = findElementsByAttr;
        const $instanceRoot = element;
        const component = components[element.localName];
        const name = component.name;
        const tests = [];
        const $it = async (description, test) => {
            tests.push({description, test});
        };
        const $expect = (value) => {
            const check = (test, message) => {
                if (! test) {
                    throw new Error(message);
                }
            };
            const toEqual = (val) => check(val === value, `${value} does not equal ${val}`);
            const expectation = {
                toEqual
            };
            return expectation;
        };
        const $_run = async () => {
            const errors = [];
            for(__test of tests) {
                try {
                    await __test.test();
                } catch (e) {
                    console.warn('test failure:', __test.description, e);
                    errors.push(e);
                }
            }
            const errorCount = errors.length;
            return { errorCount };
        };
        verify = component.verify ?
            (async () => {
                component.verify($it, $expect, $findElementsByAttr, $instanceRoot, $flush);
                return $_run();
            }) : () => Promise.resolve({ errorCount: 0});

        return { name, verify };
    };

    /* mounts an app */
    const $mount = (element, parentData) => {
        if (!element) {
            throw new Error('mounting invalid element');
        }
        const preliminaryInstance = {data: parentData};
        processRegularDirectives(preliminaryInstance, attributeAppEntryDirectives, [element], element, []);  // potentially adds stuff to preliminaryInstance.data
        const { instance, templateNode } = mount(preliminaryInstance, element);

        const refresh = () => {
            scheduleRefresh({callback: () => {
                /* empty node of children */
                while (element.lastChild) {
                    element.removeChild(element.lastChild);
                }

                /* put new children back in */
                const childElements = processTemplateElement(instance, templateNode);
                for (child of childElements) {
                    element.appendChild(child);
                }

            }});
        };

        return { instance, element, refresh };
    };

    const $testHarness = ({element}) => {
        return testHarness(element);
    };

    return {
        $component,
        $attributeDirective,
        $mount,
        $testHarness,
    };
})();

/*
 * Built-in directives
 *
 */

$attributeDirective({
    test: (attribute) => attribute.name.startsWith('$attr:'),
    processor: ($, instance, node, childNodes, newNode, attribute) => {
        const attrKey = attribute.name.substr('$attr:'.length);
        const expression = attribute.value;
        const value = $.evaluate(instance, expression);
        newNode.setAttribute(attrKey, value);
        return {};
    }
});

$attributeDirective({
    options: { appEntry: true },
    test: (attribute) => attribute.name == '$data',
    processor: ($, instance, node, childNodes, newNode, attribute) => {
        const evaluatedData = $.evaluate(instance, attribute.value);
        for (const [key, value] of Object.entries(evaluatedData) ) {
            instance.data[key] = value;
        }
        return {};
    }
});

$attributeDirective({
    test: (attribute) => attribute.name.startsWith('$event:'),
    processor: ($, instance, node, childNodes, newNode, attribute) => {
        const { data } = instance;
        const eventName = attribute.name.substr('$event:'.length);
        const handler = () => { $.evaluate(instance, attribute.value); };
        newNode.addEventListener(eventName, handler);
        return {};
    }
});

$attributeDirective({
    options: { generatesNodes: true },
    test: (attribute) => attribute.name === '$for',
    processor: ($, parentInstance, node, childNodes, newNodes, attribute) => {
        const [iter, op, ...c] = attribute.value.split(' ');
        const collection = c.join(' ');
        const buildChildren = (iterValue) => {
            const instance = { ...parentInstance, data: { ...parentInstance.data}  };
            instance.data[iter] = iterValue;
            const newNode = node.cloneNode();
            // newNode.setAttribute('$templateNodeId', newNode.id)
            delete newNode.id;
            for (childElement of node.childNodes) {
                const newChildren = $.processTemplateElement(instance, childElement);
                for (const newChild of newChildren) {
                    newNode.appendChild(newChild);
                }
            }
            newNodes.push(newNode);
        };
        if (op === 'in') {
            /* untested */
            for (x in $.evaluate(parentInstance, collection)) {
                buildChildren(x);
            }
        } else if (op === 'of') {
            for (x of $.evaluate(parentInstance, collection)) {
                buildChildren(x);
            }
        }

        const processChildren = false;
        return processChildren;
    }
});

(function() {
    const $ifScopes = {};
    $attributeDirective({
        test: (attribute) => ['$if', '$else-if', '$else'].indexOf(attribute.name) > -1,
        processor: ($, instance, node, childNodes, newNode, attribute) => {
            const scope = node.parentElement.id;
            const expression = attribute.value;
            switch(attribute.name) {
                case '$if': {
                    const value = $.evaluate(instance, expression);
                    $ifScopes[scope] = { value };
                    return value ? {} : {skipProcessingFurtherChildren: true};
                }
                case '$else-if': {
                    if ($ifScopes[scope] === undefined) {
                        throw new Error('$else-if without $if');
                    }
                    if ($ifScopes[scope].value) {
                        return {skipProcessingFurtherChildren: true};
                    }
                    const value = $.evaluate(instance, expression);
                    $ifScopes[scope].value ||= value;
                    return value ? {} : {skipProcessingFurtherChildren: true};
                }
                default:
                case '$else': {
                    if ($ifScopes[scope] === undefined) {
                        throw new Error('$else without $if');
                    }
                    const value = ! $ifScopes[scope].value;
                    $ifScopes[scope] = undefined;
                    return value ? {} : {skipProcessingFurtherChildren: true};
                }
            }
        }
    });
}
)();
